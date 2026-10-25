// Broadcast graphics (score bugs, captions, logos in boxes): axis-aligned rectangles with straight
// edges exactly along an image row and column. Nothing on a court seen in perspective makes that,
// so a rectangle bounded on all four sides by such edges is masked out of the court.
//   findOverlays(rgba, W, H) -> [[x0, y0, x1, y1], ...] in rgba pixels
// In video, StaticMask adds what stays fixed in the image while the camera moves.

export function findOverlays(rgba, W, H, opt = {}) {
  const w = opt.width ?? 640, k = W / w, h = Math.round(H / k);
  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (Math.min(H - 1, Math.round(y * k)) * W + Math.min(W - 1, Math.round(x * k))) * 4; L[y * w + x] = 0.3 * rgba[o] + 0.59 * rgba[o + 1] + 0.11 * rgba[o + 2]; }
  const thr = opt.edge ?? 22, minLen = Math.round(w * 0.05);
  // horizontal edges: runs of strong vertical gradient along one row
  const hs = [];
  for (let y = 1; y < h - 1; y++) {
    // a run may skip up to 3 px (floor grain or a leg crossing a caption's edge)
    let x0 = -1, lastOn = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && Math.abs(L[(y + 1) * w + x] - L[(y - 1) * w + x]) > thr && Math.abs(L[(y + 1) * w + x] - L[(y - 1) * w + x]) > 1.6 * Math.abs(L[y * w + Math.min(w - 1, x + 1)] - L[y * w + Math.max(0, x - 1)]);
      if (on) { if (x0 < 0) x0 = x; lastOn = x; continue; }
      if (x0 >= 0 && (x === w || x - lastOn > 3)) { if (lastOn + 1 - x0 >= minLen) hs.push({ y, x0, x1: lastOn }); x0 = -1; }
    }
  }
  // merge the two or three adjacent rows a blurred edge spans
  hs.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const edges = [];
  for (const s of hs) { const e = edges.find((e) => s.y - e.y <= 2 && s.x0 < e.x1 && s.x1 > e.x0); if (e) { e.x0 = Math.min(e.x0, s.x0); e.x1 = Math.max(e.x1, s.x1); e.y = s.y; } else edges.push({ ...s, y0: s.y }); }
  const vert = (x, ya, yb) => { // fraction of rows ya..yb with a vertical edge at column x (±1)
    let n = 0; for (let y = ya; y <= yb; y++) { let best = 0; for (let dx = -1; dx <= 1; dx++) { const X = x + dx; if (X < 1 || X >= w - 1) continue; best = Math.max(best, Math.abs(L[y * w + X + 1] - L[y * w + X - 1])); } if (best > thr) n++; }
    return n / Math.max(1, yb - ya + 1);
  };
  const rects = [];
  for (const a of edges) for (const b of edges) {
    const dy = b.y0 - a.y; if (dy < h * 0.018 || dy > h * 0.16) continue;
    const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x1, b.x1); if (x1 - x0 < minLen) continue;
    if ((x1 - x0) < 0.7 * Math.min(a.x1 - a.x0, b.x1 - b.x0)) continue;
    // both ends closed by vertical edges, or the rectangle reaches the frame edge
    const ya = a.y + 1, yb = b.y0 - 1, left = x0 <= 2 || vert(a.x0 > b.x0 ? a.x0 : b.x0, ya, yb) > 0.6, right = x1 >= w - 3 || vert(Math.min(a.x1, b.x1), ya, yb) > 0.6;
    // a score bug is several boxes side by side under one top and bottom edge: once one box closes,
    // take the whole run of the two edges
    if (left && right) {
      // grow sideways while the top and bottom edges carry on (weaker where a box's fill is close to
      // the court behind it)
      const edgeAt = (x, y) => { for (let j = -1; j <= 1; j++) { const Y = y + j; if (Y >= 1 && Y < h - 1 && Math.abs(L[(Y + 1) * w + x] - L[(Y - 1) * w + x]) > 0.6 * thr) return true; } return false; };
      const grow = (x, dir) => { let miss = 0, run = 0, end = x; for (let X = x + dir; X >= 0 && X < w; X += dir) { const ok = edgeAt(X, a.y) || edgeAt(X, a.y0); const ok2 = edgeAt(X, b.y) || edgeAt(X, b.y0); if (ok && ok2) { end = X; miss = Math.max(0, miss - 1); } else if (++miss > 6) break; run++; } return end; };
      rects.push([grow(Math.max(a.x0, b.x0), -1) * k, a.y0 * k, (grow(Math.min(a.x1, b.x1), 1) + 1) * k, (b.y + 1) * k]);
    }
  }
  // caption tabs ("GAME BALL", a player's name) sit on top of a score bug: a row edge a little above
  // a found rectangle, within its width, closes a tab whether or not its short sides show
  for (const R of rects.slice()) {
    const top = R[1] / k;
    for (const a of edges) {
      const dy = top - a.y; if (dy < h * 0.018 || dy > h * 0.07) continue;
      if (a.x0 * k < R[0] - 4 * k || (a.x1 + 1) * k > R[2] + 4 * k || a.x1 - a.x0 > 0.9 * (R[2] - R[0]) / k) continue;
      rects.push([a.x0 * k, a.y0 * k, (a.x1 + 1) * k, R[1]]);
    }
  }
  return rects;
}

// Pixels that stay the same while the court moves under them: graphics, a broadcaster's bug, a
// glass panel smudge. Updated per analysed frame with the camera's image motion; a pixel counts
// as static once it has stayed within a few levels for many frames in which the court moved.
export class StaticMask {
  constructor(w, h) { this.w = w; this.h = h; this.prev = null; this.score = new Float32Array(w * h); }
  // rgba downsampled to w x h by the caller; moved: how far (px) the court moved since the last call
  update(gray, moved) {
    if (this.prev && moved > 2) for (let i = 0; i < gray.length; i++) {
      const same = Math.abs(gray[i] - this.prev[i]) < 6;
      this.score[i] = same ? Math.min(30, this.score[i] + 1) : Math.max(0, this.score[i] - 3);
    }
    this.prev = gray.slice();
  }
  isStatic(i) { return this.score[i] >= 8; }
}

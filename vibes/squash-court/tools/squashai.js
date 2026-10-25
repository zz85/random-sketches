// SquashAI datasets (github.com/squashai/datasets, Apache-2.0): 1,253 hand-labelled stills from 8
// PSA broadcast videos. Per frame: the player boxes (pboxes.csv), the four inner corners of the
// T-area between the service boxes (tboxes.csv), the players' floor positions placed by hand in
// their editor (positions.csv) and names, shirt colours, action / replay tags (attributes.csv).
// The images themselves are not in the repo: tools/squashai_fetch.mjs downloads the videos and
// extracts them.
//
// Caveats, measured (see the README):
//   - the T-box corners are clicked once per camera set-up and reused, so on a pan, zoom or cut
//     they are stale: they are ground truth only on frames whose fitted court agrees with them;
//   - positions.csv was dragged by hand on a 3D court, about half a metre loose;
//   - in pboxes.csv players are not in a fixed order (p1 is not always the positions.csv p1).
import { readFileSync } from 'fs';
import { W, L } from '../court.js';

// one CSV, keyed by image filename ("media/images/<id>-<ms>.jpg"); numbers parsed, empty -> null
export function readCsv(text) {
  const rows = text.trim().split('\n').map((l) => l.replace(/\r$/, '').split(';'));
  const head = rows.shift();
  return Object.fromEntries(rows.map((c) => [c[0], Object.fromEntries(head.slice(1).map((h, i) => { const v = c[i + 1]; return [h, v === '' || v == null ? null : isNaN(+v) ? v : +v]; }))]));
}

export function loadLabels(dir) {
  const r = (f) => readCsv(readFileSync(`${dir}/${f}`, 'utf8'));
  const T = r('tboxes.csv'), P = r('pboxes.csv'), Q = r('positions.csv'), A = r('attributes.csv');
  return Object.keys(T).map((file) => {
    const t = T[file], p = P[file] ?? {}, q = Q[file] ?? {}, a = A[file] ?? {};
    const boxes = ['p1', 'p2'].filter((k) => p[`${k}.x`] != null).map((k) => { const x = p[`${k}.x`], y = p[`${k}.y`], w = p[`${k}.w`], h = p[`${k}.h`]; return [x - w / 2, y - h / 2, x + w / 2, y + h / 2]; });
    const positions = ['p1', 'p2'].filter((k) => q[`${k}.x`] != null).map((k) => fromSquashAI([q[`${k}.x`], q[`${k}.y`]]));
    return {
      file, video: file.split('/').pop().replace(/-\d+\.jpg$/, ''),
      tbox: [[t['tl.x'], t['tl.y']], [t['tr.x'], t['tr.y']], [t['br.x'], t['br.y']], [t['bl.x'], t['bl.y']]],
      boxes, positions, action: a.action === 'True', replay: a.replay === 'True',
      names: [a['p1.name'], a['p2.name']], colours: [a['p1.color'], a['p2.color']],
    };
  });
}

// SquashAI's floor frame: origin at the court centre, x in (-3.2, 3.2) with +x on the main
// camera's right (our x = 0, the right-hand wall facing the front), y in (-4.875, 4.875) with +y
// toward the front wall. Ours: x 0 … 6.4 from the right wall, y from the front wall.
export const fromSquashAI = ([x, y]) => [W / 2 - x, L / 2 - y];

// The T-box corners tl, tr, br, bl on the floor: the edges of the service-box side lines facing
// the T (1.6 m from each side wall), from the short line's back edge to the boxes' back lines.
export const TBOX_WORLD = [[W - 1.6, 5.44], [1.6, 5.44], [1.6, 7.04], [W - 1.6, 7.04]];

// Plane homography from 4+ point pairs (DLT with h33 = 1, normal equations)
export function homography(src, dst) {
  const n = 8, N = Array.from({ length: n }, () => new Float64Array(n + 1));
  const add = (r, b) => { for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) N[i][j] += r[i] * r[j]; N[i][n] += r[i] * b; } };
  for (let i = 0; i < src.length; i++) { const [x, y] = src[i], [u, v] = dst[i]; add([x, y, 1, 0, 0, 0, -u * x, -u * y], u); add([0, 0, 0, x, y, 1, -v * x, -v * y], v); }
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(N[r][c]) > Math.abs(N[p][c])) p = r;
    [N[c], N[p]] = [N[p], N[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = N[r][c] / N[c][c]; for (let j = c; j <= n; j++) N[r][j] -= f * N[c][j]; }
  }
  return [...N.map((r, i) => r[n] / r[i]), 1];
}
export const applyH = (h, [x, y]) => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };

export function iou(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const i = w * h; return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i);
}

// One-to-one matching, best score first: pairs [i, j, score] with score >= min
export function greedyMatch(A, B, score, min) {
  const c = []; for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) { const s = score(A[i], B[j]); if (s >= min) c.push([i, j, s]); }
  c.sort((a, b) => b[2] - a[2]);
  const ua = new Set(), ub = new Set(), out = [];
  for (const [i, j, s] of c) if (!ua.has(i) && !ub.has(j)) { ua.add(i); ub.add(j); out.push([i, j, s]); }
  return out;
}

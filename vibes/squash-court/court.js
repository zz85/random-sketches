// Squash court model (WSF singles court), metres.
// World frame: x across the court (0 … 6.4; x = 0 is the right-hand side for a player facing the front wall, suffixes R / L), y from the front wall (0) to the back wall (9.75), z up.
// Dimensions are as specified: heights to the top edge of a line, the short line to its back edge,
// the service boxes 1.6 m to the outer edge of their lines. Lines are 50 mm wide; the model holds
// their centre lines, since that is what the detector finds.

export const W = 6.4, L = 9.75, LINE = 0.05;

// Tin height: 0.48 m in the WSF rules, 0.43 m (17 in) on the men's PSA tour.
export const TINS = [0.48, 0.43];

export function courtModel({ tin = 0.48, back: backH = 2.13 } = {}) {
  const h = LINE / 2;
  const front = 4.57, back = backH, service = 1.78, short = 5.44, box = 1.6;
  const seg = (name, kind, a, b) => ({ name, kind, a, b });
  const lines = [
    // front wall (y = 0)
    seg('front-out', 'front', [0, 0, front - h], [W, 0, front - h]),
    seg('service', 'front', [0, 0, service - h], [W, 0, service - h]),
    seg('tin', 'front', [0, 0, tin - h], [W, 0, tin - h]),
    // side walls: the out line falls from 4.57 at the front to 2.13 at the back
    seg('side-out-R', 'side', [0, 0, front - h], [0, L, back - h]),
    seg('side-out-L', 'side', [W, 0, front - h], [W, L, back - h]),
    // back wall
    seg('back-out', 'back', [0, L, back - h], [W, L, back - h]),
    // floor
    seg('short', 'floor', [0, short - h, 0], [W, short - h, 0]),
    seg('half', 'floor', [W / 2, short, 0], [W / 2, L, 0]),
    seg('box-R-side', 'floor', [box - h, short, 0], [box - h, short + box, 0]),
    seg('box-R-back', 'floor', [0, short + box - h, 0], [box, short + box - h, 0]),
    seg('box-L-side', 'floor', [W - box + h, short, 0], [W - box + h, short + box, 0]),
    seg('box-L-back', 'floor', [W - box, short + box - h, 0], [W, short + box - h, 0]),
  ];
  // the box itself: where walls meet the floor and each other (drawn, not painted)
  const edges = [
    seg('floor-front', 'edge', [0, 0, 0], [W, 0, 0]),
    seg('floor-R', 'edge', [0, 0, 0], [0, L, 0]),
    seg('floor-L', 'edge', [W, 0, 0], [W, L, 0]),
    seg('floor-back', 'edge', [0, L, 0], [W, L, 0]),
    seg('corner-front-R', 'edge', [0, 0, 0], [0, 0, front]),
    seg('corner-front-L', 'edge', [W, 0, 0], [W, 0, front]),
    seg('corner-back-R', 'edge', [0, L, 0], [0, L, back]),
    seg('corner-back-L', 'edge', [W, L, 0], [W, L, back]),
  ];
  return { lines, edges, tin, W, L };
}

// Points every `step` metres along the painted lines, each with its segment's unit direction.
export function samplePoints(model, step = 0.1) {
  const pts = [];
  model.lines.forEach((s, si) => {
    const d = s.b.map((v, i) => v - s.a[i]), len = Math.hypot(...d), n = Math.max(2, Math.ceil(len / step) + 1);
    const u = d.map((v) => v / len);
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);
      pts.push({ X: s.a.map((v, i) => v + d[i] * t), dir: u, seg: si, kind: s.kind, name: s.name });
    }
  });
  return pts;
}

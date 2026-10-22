/*
 * paper.js - procedural watercolour paper as a tileable height field (0 = valley, 1 = peak).
 *
 * Mould-made watercolour paper gets its surface from the felt it is pressed against:
 * cold press ("NOT") is a field of soft irregular bumps, rough is the same with larger,
 * deeper cells, hot press is rolled smooth and keeps only the faint fibre structure. We
 * model the bumps with tileable Worley noise (soft inverted F1 distance), add fBm for the
 * mottling and a sprinkle of short fibres, then normalise. Everything wraps, so the tile
 * repeats seamlessly over the sheet and the simulation can sample it with REPEAT.
 */

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function valueNoise(N, period, rand) {
  const g = new Float32Array(period * period); for (let i = 0; i < g.length; i++) g[i] = rand();
  const out = new Float32Array(N * N), f = period / N;
  for (let y = 0; y < N; y++) {
    const fy = y * f, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty), y1 = (y0 + 1) % period;
    for (let x = 0; x < N; x++) {
      const fx = x * f, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx), x1 = (x0 + 1) % period;
      const a = g[y0 * period + x0], b = g[y0 * period + x1], c = g[y1 * period + x0], d = g[y1 * period + x1];
      out[y * N + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    }
  }
  return out;
}

function worley(N, cells, rand, jitter = 0.9) {
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < cells * cells; i++) { pts[2 * i] = 0.5 + (rand() - 0.5) * jitter; pts[2 * i + 1] = 0.5 + (rand() - 0.5) * jitter; }
  const out = new Float32Array(N * N), cs = N / cells;
  for (let y = 0; y < N; y++) {
    const cy = Math.floor(y / cs), fy = y / cs - cy;
    for (let x = 0; x < N; x++) {
      const cx = Math.floor(x / cs), fx = x / cs - cx;
      let d1 = 9, d2 = 9;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const gx = (cx + i + cells) % cells, gy = (cy + j + cells) % cells, k = 2 * (gy * cells + gx);
        const dx = i + pts[k] - fx, dy = j + pts[k + 1] - fy, d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      // dome over each cell, with a crease between neighbouring cells
      out[y * N + x] = Math.min(1, Math.sqrt(d2) - Math.sqrt(d1)) * 0.6 + (1 - Math.min(1, Math.sqrt(d1) * 1.2)) * 0.4;
    }
  }
  return out;
}

function blur(a, N, r) {
  const t = new Float32Array(N * N), o = new Float32Array(N * N), w = 2 * r + 1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0; for (let k = -r; k <= r; k++) s += a[y * N + ((x + k + N) % N)]; t[y * N + x] = s / w; }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0; for (let k = -r; k <= r; k++) s += t[((y + k + N) % N) * N + x]; o[y * N + x] = s / w; }
  return o;
}

function fibres(N, count, rand) {
  const f = new Float32Array(N * N);
  for (let n = 0; n < count; n++) {
    let x = rand() * N, y = rand() * N, a = rand() * Math.PI * 2; const len = 10 + rand() * 40, s = 0.3 + rand() * 0.7;
    for (let i = 0; i < len; i++) { a += (rand() - 0.5) * 0.35; x += Math.cos(a); y += Math.sin(a); const k = ((Math.floor(y) % N + N) % N) * N + ((Math.floor(x) % N + N) % N); f[k] = Math.max(f[k], s); }
  }
  return blur(f, N, 1);
}

export const PAPERS = {
  cold: { name: 'Cold press', cells: 46, depth: 1.0, fbm: 0.35, fibre: 0.25, contrast: 1.0, absorb: 1.0, note: 'medium grain, the all-rounder' },
  rough: { name: 'Rough', cells: 24, depth: 1.0, fbm: 0.45, fibre: 0.2, contrast: 1.25, absorb: 1.15, note: 'deep tooth, strong granulation and drybrush' },
  hot: { name: 'Hot press', cells: 80, depth: 0.25, fbm: 0.6, fibre: 0.5, contrast: 0.45, absorb: 0.8, note: 'smooth, crisp edges, paint sits on top' },
};

/** Tileable height field {N, h: Float32Array} for a paper type. */
export function makePaper(type = 'cold', N = 512, seed = 1) {
  const P = PAPERS[type] || PAPERS.cold, rand = rng(seed * 9973 + type.length);
  const w = worley(N, Math.round(P.cells * N / 512), rand);
  const n1 = valueNoise(N, Math.round(N / 32), rand), n2 = valueNoise(N, Math.round(N / 8), rand), n3 = valueNoise(N, Math.round(N / 3), rand);
  const fb = fibres(N, Math.round(N * N / 900), rand);
  let h = new Float32Array(N * N);
  for (let i = 0; i < h.length; i++) h[i] = P.depth * w[i] + P.fbm * (0.5 * n1[i] + 0.3 * n2[i] + 0.2 * n3[i]) + P.fibre * fb[i];
  h = blur(h, N, 1);
  // normalise to mean 0.5, scale spread by the paper's contrast, clamp to 0..1
  let m = 0; for (const v of h) m += v; m /= h.length;
  let sd = 0; for (const v of h) sd += (v - m) * (v - m); sd = Math.sqrt(sd / h.length) || 1;
  for (let i = 0; i < h.length; i++) h[i] = Math.min(1, Math.max(0, 0.5 + (h[i] - m) / sd * 0.2 * P.contrast));
  return { N, h, type, absorb: P.absorb };
}

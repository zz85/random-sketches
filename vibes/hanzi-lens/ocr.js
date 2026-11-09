/*
 * ocr.js - the PP-OCRv5 pipeline around the two models, in plain JS (no DOM, no ort):
 * image -> detector input, the detector's probability map -> line boxes (DB post-process),
 * line box -> recogniser input (rotated for vertical text), recogniser output -> text with
 * the position of each character along the line (CTC decoding). The worker owns the
 * sessions and calls these. Tested in ocr.test.js.
 *
 * Images are { data: Uint8ClampedArray RGBA, width, height }, as ImageData.
 * A quad is [[x,y] x4] in image pixels: top-left, top-right, bottom-right, bottom-left
 * of the text as read (for a vertical column, "top-left" is its top-right corner, so the
 * first edge runs down the column).
 */

// Values from the models' inference.yml. Paddle feeds BGR and normalises the channels in
// that order with the ImageNet mean and std, so channel 0 (blue) gets 0.485 / 0.229.
const DET_MEAN = [0.485, 0.456, 0.406], DET_STD = [0.229, 0.224, 0.225];
export const DET = { thresh: 0.3, boxThresh: 0.6, unclip: 1.5, minSize: 3 };
export const REC_H = 48, REC_MIN_W = 160, REC_MAX_W = 3200, REC_STEP = 64;

// ---- detection ----

/**
 * Detector size for an image: longest side `longSide` (scaled up too: small text, such as a
 * dense menu in a small photo, merges into blobs at its own size), both sides multiples of 32.
 */
export function detSize(w, h, longSide) {
  const s = longSide / Math.max(w, h);
  return { w: Math.max(32, Math.round((w * s) / 32) * 32), h: Math.max(32, Math.round((h * s) / 32) * 32) };
}

/** RGBA pixels already at detector size -> Float32 NCHW, BGR, normalised. */
export function detTensor(img) {
  const { data, width: w, height: h } = img, n = w * h, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    out[i] = (b - DET_MEAN[0]) / DET_STD[0];
    out[n + i] = (g - DET_MEAN[1]) / DET_STD[1];
    out[2 * n + i] = (r - DET_MEAN[2]) / DET_STD[2];
  }
  return out;
}

function convexHull(pts) {   // pts: flat [x0,y0,x1,y1...] -> [[x,y]...] counter-clockwise
  const p = [];
  for (let i = 0; i < pts.length; i += 2) p.push([pts[i], pts[i + 1]]);
  p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

/** Minimum-area rectangle around a convex hull: { cx, cy, ux, uy, w, h } with u the long-ish axis within 45 deg of x. */
export function minAreaRect(hull) {
  if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], ux: 1, uy: 0, w: 0, h: 0 };
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    let ux = b[0] - a[0], uy = b[1] - a[1];
    const len = Math.hypot(ux, uy);
    if (len < 1e-9) continue;
    ux /= len; uy /= len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of hull) {
      const u = q[0] * ux + q[1] * uy, v = -q[0] * uy + q[1] * ux;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uy, u0, u1, v0, v1 };
  }
  let { ux, uy, u0, u1, v0, v1 } = best;
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
  const cx = um * ux - vm * uy, cy = um * uy + vm * ux;
  let w = u1 - u0, h = v1 - v0;
  // turn the frame so u is the axis nearest to +x (v then points down the page)
  for (let k = 0; k < 4 && !(Math.abs(uy) <= Math.abs(ux) && ux > 0); k++) { [ux, uy] = [-uy, ux]; [w, h] = [h, w]; }
  return { cx, cy, ux, uy, w, h };
}

/** Rectangle -> quad in reading order; columns at least 1.5x taller than wide read top to bottom. */
export function rectQuad({ cx, cy, ux, uy, w, h }) {
  const vx = -uy, vy = ux, hw = w / 2, hh = h / 2;
  const at = (su, sv) => [cx + ux * hw * su + vx * hh * sv, cy + uy * hw * su + vy * hh * sv];
  const tl = at(-1, -1), tr = at(1, -1), br = at(1, 1), bl = at(-1, 1);
  const vertical = h >= 1.5 * w && h > 0;
  return { quad: vertical ? [tr, br, bl, tl] : [tl, tr, br, bl], vertical };
}

/**
 * DB post-processing: probability map (mapW x mapH, values 0..1) -> text boxes in image
 * pixels (scale sx, sy from map to image). Each connected region over `thresh` is a line;
 * it is kept when its mean probability is over `boxThresh`, and grown by the DB unclip
 * distance (area * ratio / perimeter), since the model predicts a shrunk text kernel.
 */
export function dbBoxes(prob, mapW, mapH, sx, sy, opt = {}) {
  const { thresh, boxThresh, unclip, minSize, oy = 0 } = { ...DET, ...opt };   // oy: the map's first row in a taller map (bands)
  const n = mapW * mapH, label = new Int32Array(n), boxes = [];
  const stack = new Int32Array(n);
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] || prob[s] <= thresh) continue;
    next++;
    let top = 0, sum = 0, count = 0, yMin = Infinity, yMax = -Infinity;
    stack[top++] = s; label[s] = next;
    const edge = [];                     // boundary pixels, enough for the hull
    while (top) {
      const p = stack[--top], x = p % mapW, y = (p - x) / mapW;
      sum += prob[p]; count++;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      let boundary = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= mapW || yy >= mapH) { boundary = true; continue; }
        const q = yy * mapW + xx;
        if (prob[q] <= thresh) { boundary = true; continue; }
        if (!label[q]) { label[q] = next; stack[top++] = q; }
      }
      if (boundary) edge.push(x, y, x + 1, y, x, y + 1, x + 1, y + 1);   // pixel corners
    }
    if (count < 4 || sum / count < boxThresh) continue;
    const rect = minAreaRect(convexHull(edge));
    if (Math.min(rect.w, rect.h) < minSize) continue;
    const d = (rect.w * rect.h * unclip) / (2 * (rect.w + rect.h));
    rect.w += 2 * d; rect.h += 2 * d;
    if (Math.min(rect.w, rect.h) < minSize + 2) continue;
    // to image pixels (the map is the detector input, scaled from the image by sx, sy)
    const cx = rect.cx * sx, cy = (rect.cy + oy) * sy;
    const ux = rect.ux * sx, uy = rect.uy * sy, ul = Math.hypot(ux, uy);
    const vx = -rect.uy * sx, vy = rect.ux * sy, vl = Math.hypot(vx, vy);
    const r = { cx, cy, ux: ux / ul, uy: uy / ul, w: rect.w * ul, h: rect.h * vl };
    const { quad, vertical } = rectQuad(r);
    boxes.push({ quad, vertical, score: sum / count, rect: r, mapCy: rect.cy + oy, mapY0: yMin + oy, mapY1: yMax + oy });
  }
  return boxes;
}

/** Reading order: horizontal lines top to bottom (left to right on one row), columns right to left. */
export function readingOrder(lines) {
  const c = (l) => [l.quad.reduce((s, p) => s + p[0], 0) / 4, l.quad.reduce((s, p) => s + p[1], 0) / 4];
  return [...lines].sort((a, b) => {
    const [ax, ay] = c(a), [bx, by] = c(b);
    if (a.vertical && b.vertical) return bx - ax || ay - by;
    const ah = Math.min(a.rect.w, a.rect.h), bh = Math.min(b.rect.w, b.rect.h);
    if (!a.vertical && !b.vertical && Math.abs(ay - by) < 0.5 * Math.min(ah, bh)) return ax - bx;
    return ay - by;
  });
}

// ---- recognition ----

/** Length and thickness of a quad: along its first edge and its second. */
export function quadSize(q) {
  return { len: Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), thick: Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) };
}

/**
 * Sample a line straight out of the image into the recogniser's input: height 48, width in
 * proportion, padded to a multiple of REC_STEP (so WebGPU sees a few shapes, not one per
 * line). Reading direction runs along the quad's first edge, so a vertical column comes out
 * turned 90 deg counter-clockwise, as PP-OCRv5 was trained on it.
 * Returns { tensor (Float32 NCHW BGR in -1..1), width (padded), used (columns of text) }.
 */
export function recTensor(img, quad) {
  const { len, thick } = quadSize(quad);
  const used = Math.max(8, Math.min(REC_MAX_W, Math.round((REC_H * len) / Math.max(1, thick))));
  const width = Math.min(REC_MAX_W, Math.max(REC_MIN_W, Math.ceil(used / REC_STEP) * REC_STEP));
  const n = REC_H * width, out = new Float32Array(3 * n);   // padding stays 0 (mid grey), as Paddle pads
  const [o, a, , b] = quad;
  const ex = [(a[0] - o[0]) / used, (a[1] - o[1]) / used], ey = [(b[0] - o[0]) / REC_H, (b[1] - o[1]) / REC_H];
  // filter wide when shrinking a lot, so small text doesn't alias
  const step = Math.max(1, Math.min(len / used, thick / REC_H));
  const taps = step > 1.6 ? [-0.25, 0.25] : [0];
  const { data, width: W, height: H } = img;
  const px = (x, y, c) => {
    x = Math.min(W - 1, Math.max(0, x)); y = Math.min(H - 1, Math.max(0, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const i00 = (y0 * W + x0) * 4 + c, i10 = (y0 * W + x1) * 4 + c, i01 = (y1 * W + x0) * 4 + c, i11 = (y1 * W + x1) * 4 + c;
    return (data[i00] * (1 - fx) + data[i10] * fx) * (1 - fy) + (data[i01] * (1 - fx) + data[i11] * fx) * fy;
  };
  for (let j = 0; j < REC_H; j++) for (let i = 0; i < used; i++) {
    let r = 0, g = 0, bl = 0, k = 0;
    for (const ti of taps) for (const tj of taps) {
      const u = i + 0.5 + ti, v = j + 0.5 + tj;
      const x = o[0] + ex[0] * u + ey[0] * v - 0.5, y = o[1] + ex[1] * u + ey[1] * v - 0.5;
      r += px(x, y, 0); g += px(x, y, 1); bl += px(x, y, 2); k++;
    }
    const p = j * width + i;
    out[p] = bl / k / 127.5 - 1; out[n + p] = g / k / 127.5 - 1; out[2 * n + p] = r / k / 127.5 - 1;
  }
  return { tensor: out, width, used };
}

/** Parse the character list out of the recogniser's inference.yml. */
export function parseRecDict(yml) {
  const lines = yml.split('\n'), out = [];
  let i = lines.findIndex((l) => /^\s*character_dict:\s*$/.test(l));
  if (i < 0) throw new Error('no character_dict in inference.yml');
  for (i++; i < lines.length; i++) {
    const m = /^\s*- (.*)$/.exec(lines[i]);
    if (!m) break;
    let s = m[1];
    if (/^'.*'$/.test(s)) s = s.slice(1, -1).replace(/''/g, "'");
    else if (/^".*"$/.test(s)) s = JSON.parse(s);
    out.push(s);
  }
  return out;
}

/**
 * CTC greedy decoding of the recogniser's output [T, C] (softmax already applied).
 * Class 0 is the blank, 1..dict.length the characters, the last a space.
 * Returns { text, confidence, chars: [{ ch, pos }] } where pos is the character's centre
 * as a fraction 0..1 along the line.
 */
export function ctcDecode(probs, T, C, dict, width, used) {
  const chars = [];
  let prev = 0, run = null, confSum = 0;
  for (let t = 0; t < T; t++) {
    let best = 0, bp = -1;
    const base = t * C;
    for (let c = 0; c < C; c++) { const v = probs[base + c]; if (v > bp) { bp = v; best = c; } }
    if (best !== 0 && best === prev && run) { run.t1 = t; run.p = Math.max(run.p, bp); }
    else if (best !== 0) {
      const ch = best - 1 < dict.length ? dict[best - 1] : ' ';
      run = { ch, t0: t, t1: t, p: bp };
      chars.push(run);
    } else run = null;
    prev = best;
  }
  const stepPx = width / T;
  const out = chars.map((r) => ({ ch: r.ch, pos: Math.min(1, ((r.t0 + r.t1 + 1) / 2) * stepPx / used), p: r.p }));
  for (const c of out) confSum += c.p;
  const text = out.map((c) => c.ch).join('').replace(/\s+/g, ' ').trim();
  return { text, confidence: out.length ? confSum / out.length : 0, chars: out };
}

// ---- dense grids ----

/**
 * Detector size for a pass stretched `sy` times vertically: the normal pass's width, and its
 * height times `sy` (keeping the width matters: narrower, the characters run together again).
 */
export function detSizeStretched(w, h, longSide, sy) {
  const base = detSize(w, h, longSide);
  return { w: base.w, h: Math.max(32, Math.round((base.h * sy) / 32) * 32) };
}

const bbox = (q) => { const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
const wide = (b) => { const { len, thick } = quadSize(b.quad); return !b.vertical && len >= 1.8 * thick; };

/**
 * Bands of `bh` rows covering a map `H` rows tall, overlapping by about 30%. A box belongs
 * to the band whose core (the band less half the overlap at each inner edge) holds its
 * centre, so each line is kept once and whole: a line shorter than half the overlap that is
 * centred in a core lies inside its band. Returns [{ y0, core0, core1 }] in map rows.
 */
export function bands(H, bh) {
  if (H <= bh) return [{ y0: 0, core0: 0, core1: H }];
  const n = Math.ceil((H - bh) / (bh * 0.7)) + 1, step = (H - bh) / (n - 1), out = [];
  for (let k = 0; k < n; k++) out.push({ y0: Math.round(k * step) });
  out.forEach((b, k) => {
    b.core0 = k === 0 ? 0 : (b.y0 + out[k - 1].y0 + bh) / 2;
    b.core1 = k === n - 1 ? H : (out[k + 1].y0 + b.y0 + bh) / 2;
  });
  return out;
}

/**
 * The rows of the stretched map (`H` rows tall, `sy` map rows per image pixel) that the
 * stretched pass needs to see: each column of `cols` (image pixels) with a margin of one
 * character, its width, above and below, so the rows a grid column cuts across are whole.
 * The pass runs the full width, since a row crossing a column runs well past it on both
 * sides. Spans that overlap or touch join; each is then grown to a multiple of `step`
 * rows (clamped to the map), so the detector sees few input shapes. Returns [[y0, y1]].
 */
export function gridSpans(cols, H, sy, step = 256) {
  const raw = cols.map((c) => {
    const [x0, y0, x1, y1] = bbox(c.quad), m = x1 - x0;
    return [Math.max(0, Math.floor((y0 - m) * sy)), Math.min(H, Math.ceil((y1 + m) * sy))];
  }).sort((a, b) => a[0] - b[0]);
  const grow = ([y0, y1]) => {
    const h = Math.min(H, Math.ceil((y1 - y0) / step) * step);
    const c = Math.round((y0 + y1 - h) / 2);
    const s = Math.max(0, Math.min(H - h, c));
    return [s, s + h];
  };
  let spans = [];
  for (const r of raw) {
    const p = spans[spans.length - 1];
    if (p && r[0] <= p[1]) p[1] = Math.max(p[1], r[1]); else spans.push([...r]);
  }
  // growing can make spans overlap again: join and grow until stable
  for (;;) {
    const g = spans.map(grow), out = [];
    for (const r of g) {
      const p = out[out.length - 1];
      if (p && r[0] <= p[1]) p[1] = Math.max(p[1], r[1]); else out.push([...r]);
    }
    if (out.length === g.length) return out;
    spans = out;
  }
}

/**
 * A dense menu is a grid: the gap between rows is about the gap between characters in a
 * row, and the detector joins characters of successive rows into columns. A pass on the
 * image stretched vertically separates the rows. For each column of `base` (the normal
 * pass), the lines of `stretched` that cross it decide: two or more lines at least two
 * characters wide mean it was a grid, and they replace it; otherwise (real vertical text,
 * whose characters come apart into single boxes, or stay a column) it stays.
 * Both lists are in image pixels. Returns the merged list, not yet in reading order.
 */
export function mergeGrid(base, stretched) {
  const sb = stretched.map((b) => ({ b, bb: bbox(b.quad), used: false }));
  const keep = [];
  for (const a of base) {
    if (!a.vertical) { keep.push(a); continue; }
    const ab = bbox(a.quad), aw = ab[2] - ab[0];
    const crossing = sb.filter(({ b, bb }) => {
      if (!wide(b)) return false;
      const ix = Math.min(ab[2], bb[2]) - Math.max(ab[0], bb[0]), iy = Math.min(ab[3], bb[3]) - Math.max(ab[1], bb[1]);
      return ix >= 0.5 * aw && iy >= 0.6 * (bb[3] - bb[1]);
    });
    if (crossing.length >= 2) for (const c of crossing) c.used = true;
    else keep.push(a);
  }
  const added = sb.filter((s) => s.used);
  // a line of the normal pass that the stretched lines now cover is a repeat
  const covered = (a) => {
    const ab = bbox(a.quad), area = (ab[2] - ab[0]) * (ab[3] - ab[1]);
    let over = 0;
    for (const { bb } of added) over += Math.max(0, Math.min(ab[2], bb[2]) - Math.max(ab[0], bb[0])) * Math.max(0, Math.min(ab[3], bb[3]) - Math.max(ab[1], bb[1]));
    return over > 0.4 * area;
  };
  return keep.filter((a) => !covered(a)).concat(added.map((s) => s.b));
}

// ---- room for pinyin ----

/**
 * Whether the page is too dense to label every line. Pinyin sits just above a horizontal
 * line, over the padding of the box above it (boxes are the text grown by the unclip
 * distance, about a fifth of a line's height each side). A line has no room when its box
 * touches or overlaps the box of a line above it, or when its label would be under `minPx`
 * on screen (`s` is screen pixels per image pixel). Dense when more than `share` of the
 * horizontal lines have no room.
 */
export function crowded(lines, s, { minPx = 8, share = 0.3 } = {}) {
  const flat = lines.filter((l) => !l.vertical);
  if (flat.length < 4) return false;
  const bb = flat.map((l) => { const xs = l.quad.map((p) => p[0]), ys = l.quad.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; });
  let tight = 0;
  flat.forEach((l, i) => {
    const thick = quadSize(l.quad).thick;
    let gap = Infinity;
    bb.forEach((o, j) => {
      if (j === i || o[3] > bb[i][1] + thick * 0.3) return;            // only lines above
      if (Math.min(o[2], bb[i][2]) - Math.max(o[0], bb[i][0]) <= 0) return;
      gap = Math.min(gap, bb[i][1] - o[3]);
    });
    if (gap < 0.05 * thick || thick * 0.36 * s < minPx) tight++;
  });
  return tight > share * flat.length;
}

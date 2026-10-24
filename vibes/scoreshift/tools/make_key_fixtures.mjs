// Builds the opening-key fixtures from the two Telemann scan crops (IMSLP #96616): a staff that
// starts with naturals is what a part looks like on the page after a key change at a page turn,
// and the scans already have the glyphs, engraved and scanned like the rest of the page.
//   node tools/make_key_fixtures.mjs
// For each crop: the clef, then the key change found inside the staff (♮♮♯ in maggiore, ♮♭♭ in
// minore) moved in front of the music in place of the old signature, then the first bar.
//   key_open_naturals_sharp.png    ♮♮♯  -> G major (1), naturals kept as part of the signature
//   key_open_naturals_flats.png    ♮♭♭  -> g minor (-2)
//   key_open_cancel.png            ♮♮   -> C (0), a cancellation
//   key_missing.png                no signature on one staff (taken from the previous page)
//   key_keyless_pair.png           two staves in a row with no key and no key ink
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeGray, encodeGray } from '../png.js';
import { normalize, analyze } from '../omr.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'fixtures');

// normalized -> original pixels (normalize's A: x' = a x + b y + c)
const toX = (A, x, y) => Math.round(A[0] * x + A[1] * y + A[2]);
const cols = (img, spans) => {
  const w = spans.reduce((s, [a, b]) => s + b - a, 0), out = new Uint8Array(w * img.h);
  let o = 0;
  for (const [a, b] of spans) { for (let y = 0; y < img.h; y++) out.set(img.data.subarray(y * img.w + a, y * img.w + b), y * w + o); o += b - a; }
  return { w, h: img.h, data: out };
};
const stack = (...imgs) => {
  const w = Math.max(...imgs.map((i) => i.w)), h = imgs.reduce((s, i) => s + i.h, 0), out = new Uint8Array(w * h).fill(255);
  let y0 = 0;
  for (const img of imgs) { for (let y = 0; y < img.h; y++) out.set(img.data.subarray(y * img.w, (y + 1) * img.w), (y0 + y) * w); y0 += img.h; }
  return { w, h, data: out };
};

const parts = {};
for (const name of ['maggiore', 'minore']) {
  const img = decodeGray(fs.readFileSync(path.join(FX, `scan_telemann_${name}.png`)));
  const norm = normalize(img), st = analyze(norm).staves[0], k = st.keyChanges[0];
  const X = (x) => toX(norm.A, x, (st.band[0] + st.band[1]) / 2), pad = 6;
  const clef = [0, X(st.clef.box[2]) + pad], bar = [X(st.key.x1) + pad, X(st.bars[0].x) - 4];
  const naturals = k.glyphs.filter((g) => g.type === 0);
  parts[name] = {
    open: cols(img, [clef, [X(k.x0) - pad, X(k.x1) + pad], bar]),
    cancel: cols(img, [clef, [X(k.x0) - pad, X(naturals.at(-1).box[2]) + pad], bar]),
    plain: cols(img, [clef, bar]),
  };
}
const out = {
  key_open_naturals_sharp: parts.maggiore.open,
  key_open_naturals_flats: parts.minore.open,
  key_open_cancel: parts.maggiore.cancel,
  key_missing: parts.maggiore.plain,
  key_keyless_pair: stack(parts.maggiore.plain, parts.minore.plain),
};
for (const [name, img] of Object.entries(out)) {
  fs.writeFileSync(path.join(FX, `${name}.png`), encodeGray(img));
  console.log(`fixtures/${name}.png ${img.w}x${img.h}`);
}

// node --test   (zero deps; the full dictionary and the models are checked in smoke.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import zlib from 'zlib';
import { parseDict, markSyllable, markPinyin, joinPinyin, readNumber, readTime, annotate, linePinyin, bestEntry } from './text.js';
import { detSize, detSizeStretched, minAreaRect, rectQuad, dbBoxes, ctcDecode, parseRecDict, recTensor, readingOrder, mergeGrid, crowded, bands } from './ocr.js';

const dict = parseDict(zlib.gunzipSync(fs.readFileSync(new URL('./dict/cedict.txt.gz', import.meta.url))).toString('utf8'));

test('tone marks', () => {
  assert.deepEqual(['ma1', 'ma2', 'ma3', 'ma4', 'ma5'].map(markSyllable), ['mā', 'má', 'mǎ', 'mà', 'ma']);
  assert.equal(markSyllable('lu:4'), 'lǜ');
  assert.equal(markSyllable('nu:3'), 'nǚ');
  assert.equal(markSyllable('gou3'), 'gǒu');     // o of ou
  assert.equal(markSyllable('xiu1'), 'xiū');     // last vowel
  assert.equal(markSyllable('gui4'), 'guì');
  assert.equal(markSyllable('Zhong1'), 'Zhōng');
  assert.equal(markSyllable('An1'), 'Ān');
  assert.equal(markSyllable('r5'), 'r');
  assert.equal(joinPinyin(markPinyin('nu:3 er2')), "nǚ'ér");
  assert.equal(joinPinyin(markPinyin('Xi1 an1')), "Xī'ān");
});

test('numbers and times', () => {
  const r = (s) => readNumber(s).pinyin.join('');
  assert.equal(r('10'), 'shí');
  assert.equal(r('15'), 'shíwǔ');
  assert.equal(r('28'), 'èrshíbā');
  assert.equal(r('105'), 'yībǎilíngwǔ');
  assert.equal(r('2000'), 'liǎngqiān');
  assert.equal(r('10005'), 'yīwànlíngwǔ');
  assert.equal(r('20000'), 'liǎngwàn');
  assert.equal(r('3.5'), 'sāndiǎnwǔ');
  assert.equal(r('007'), 'línglíngqī');
  assert.equal(readNumber('28').han, '二十八');
  assert.equal(readTime('10:00').pinyin.join(''), 'shídiǎn');
  assert.equal(readTime('8:05').pinyin.join(''), 'bādiǎnlíngwǔfēn');
  assert.equal(readTime('25:00'), null);
});

test('dictionary', () => {
  assert.ok(dict.count > 100000);
  assert.ok(dict.has('银行') && dict.has('銀行'), 'simplified and traditional');
});

test('words and readings from context', () => {
  const words = (s) => annotate(s, dict).tokens.filter((t) => t.kind !== 'space').map((t) => t.text);
  assert.deepEqual(words('我们去银行取钱。'), ['我们', '去', '银行', '取钱', '。']);
  assert.deepEqual(words('宫保鸡丁 28元'), ['宫保鸡丁', '28', '元']);
  assert.equal(linePinyin(annotate('银行', dict)), 'yínháng');
  assert.equal(linePinyin(annotate('行走', dict)), 'xíngzǒu');
  assert.equal(linePinyin(annotate('今天的天气很好', dict)), 'jīntiān de tiānqì hěn hǎo');
  assert.equal(linePinyin(annotate('長城', dict)), 'Chángchéng');
  assert.equal(linePinyin(annotate('你好吗？', dict)), 'nǐhǎo ma？');
});

test('one syllable over each character', () => {
  const a = annotate('麻婆豆腐 22元', dict);
  assert.deepEqual(a.charPinyin, ['má', 'pó', 'dòu', 'fǔ', null, 'èrshí\'èr', null, 'yuán']);
  assert.deepEqual(a.spans.map((s) => [s.from, s.to]), [[0, 1], [1, 2], [2, 3], [3, 4], [5, 7], [7, 8]]);
});

test('a lone character takes its common reading', () => {
  const pick = (c) => bestEntry(c, dict.get(c)).pinyin;
  assert.equal(pick('的'), 'de5');
  assert.equal(pick('了'), 'le5');
  assert.equal(pick('和'), 'he2');
  assert.equal(pick('中'), 'zhong1');
  assert.equal(pick('面'), 'mian4');
});

test('detector size', () => {
  assert.deepEqual(detSize(1280, 720, 640), { w: 640, h: 352 });
  assert.deepEqual(detSize(100, 50, 1280), { w: 1280, h: 640 });   // scaled up too, multiples of 32
});

test('rectangles and reading direction', () => {
  // a rectangle 40 wide, 10 tall, turned 10 degrees
  const a = (10 * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), pts = [];
  for (const [u, v] of [[-20, -5], [20, -5], [20, 5], [-20, 5]]) pts.push([50 + u * c - v * s, 50 + u * s + v * c]);
  const r = minAreaRect(pts);
  assert.ok(Math.abs(r.w - 40) < 1e-6 && Math.abs(r.h - 10) < 1e-6);
  assert.ok(Math.abs(Math.atan2(r.uy, r.ux) - a) < 1e-6);
  const h = rectQuad(r);
  assert.equal(h.vertical, false);
  assert.ok(h.quad[0][0] < h.quad[1][0], 'reads left to right');
  const v = rectQuad({ cx: 50, cy: 50, ux: 1, uy: 0, w: 10, h: 40 });
  assert.equal(v.vertical, true);
  assert.deepEqual(v.quad[0], [55, 30]);   // starts at the column's top-right
  assert.deepEqual(v.quad[1], [55, 70]);   // and runs down
});

test('DB boxes from a probability map', () => {
  const W = 64, H = 32, prob = new Float32Array(W * H);
  for (let y = 10; y < 16; y++) for (let x = 8; x < 50; x++) prob[y * W + x] = 0.9;   // a line
  for (let y = 2; y < 4; y++) for (let x = 2; x < 4; x++) prob[y * W + x] = 0.9;      // a speck
  const boxes = dbBoxes(prob, W, H, 2, 2);
  assert.equal(boxes.length, 1);
  const [b] = boxes;
  assert.equal(b.vertical, false);
  // grown by the unclip distance: area * 1.5 / perimeter = 42*6*1.5/96 ~ 3.9 map px each side
  assert.ok(b.rect.w > 2 * 42 && b.rect.w < 2 * 52, String(b.rect.w));
  assert.ok(Math.abs(b.rect.cx - 2 * 29) < 1 && Math.abs(b.rect.cy - 2 * 13) < 1);
});

test('reading order: rows top to bottom, columns right to left', () => {
  const L = (cx, cy, w, h) => ({ ...rectQuad({ cx, cy, ux: 1, uy: 0, w, h }), rect: { w, h } });
  const lines = [L(100, 100, 80, 20), L(20, 40, 80, 20), L(300, 300, 20, 100), L(260, 300, 20, 100), L(200, 42, 60, 20)];
  const order = readingOrder(lines).map((l) => lines.indexOf(l));
  assert.deepEqual(order.slice(0, 2), [1, 4]);
  assert.ok(order.indexOf(2) < order.indexOf(3), 'right column first');
});

test('CTC decoding with character positions', () => {
  const dictChars = ['一', '二', '三'], C = dictChars.length + 2, T = 8, probs = new Float32Array(T * C);
  // steps: 一 一 blank 二 blank 二 space 三  -> "一二二 三"
  [1, 1, 0, 2, 0, 2, 4, 3].forEach((c, t) => { probs[t * C + c] = 0.9; });
  const r = ctcDecode(probs, T, C, dictChars, 64, 64);
  assert.equal(r.text, '一二二 三');
  assert.equal(r.chars.length, 5);
  assert.ok(Math.abs(r.chars[0].pos - 1 / 8) < 1e-9);   // centre of steps 0-1
  assert.ok(Math.abs(r.confidence - 0.9) < 1e-6);
});

test('character list from inference.yml', () => {
  const yml = "PostProcess:\n  name: CTCLabelDecode\n  character_dict:\n  - 一\n  - \"'\"\n  - ' '\n  - a\nother: 1\n";
  assert.deepEqual(parseRecDict(yml), ['一', "'", ' ', 'a']);
});

test('a vertical column is turned counter-clockwise for the recogniser', () => {
  // 10x40 image: top half red, bottom half blue; one column covering it
  const W = 10, H = 40, data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; data[i] = y < 20 ? 255 : 0; data[i + 2] = y < 20 ? 0 : 255; data[i + 3] = 255; }
  const { quad } = rectQuad({ cx: 5, cy: 20, ux: 1, uy: 0, w: 10, h: 40 });
  const { tensor, width, used } = recTensor({ data, width: W, height: H }, quad);
  const n = 48 * width, red = (x) => tensor[2 * n + 24 * width + x];
  assert.ok(used === 192 && width === 192);
  assert.ok(red(10) > 0.9 && red(used - 10) < -0.9, 'top of the column is on the left');
});

test('a dense grid read as columns is replaced by the stretched pass\'s rows', () => {
  const box = (cx, cy, w, h) => ({ ...rectQuad({ cx, cy, ux: 1, uy: 0, w, h }), rect: { w, h } });
  // normal pass: one column 20 wide, 200 tall (really 5 rows of a 3-character dish)
  // stretched pass: 5 rows 60 wide, 20 tall, crossing it, plus a real column elsewhere
  // whose characters came apart into single squares
  const base = [box(100, 100, 20, 200), box(300, 100, 30, 120), box(100, 260, 80, 20)];
  const rows = [0, 1, 2, 3, 4].map((k) => box(120, 20 + k * 40, 60, 20));
  const singles = [0, 1, 2].map((k) => box(300, 60 + k * 40, 30, 30));
  const merged = mergeGrid(base, [...rows, ...singles, box(100, 260, 80, 20)]);
  assert.equal(merged.filter((b) => b.vertical).length, 1, 'the real column stays');
  assert.equal(merged.filter((b) => !b.vertical).length, 6, 'five rows, and the line below kept once');
});

test('the stretched pass keeps the normal pass\'s width', () => {
  assert.deepEqual(detSizeStretched(453, 676, 1280, 1.5), { w: 864, h: 1920 });
});

test('a page is dense when line boxes touch the line above', () => {
  const row = (cy, h = 30) => ({ ...rectQuad({ cx: 100, cy, ux: 1, uy: 0, w: 120, h }), rect: { w: 120, h } });
  const spaced = [0, 1, 2, 3, 4].map((k) => row(50 + k * 40));   // gaps of 10 = a third of the height
  const packed = [0, 1, 2, 3, 4].map((k) => row(50 + k * 28));   // boxes overlap
  assert.equal(crowded(spaced, 1), false);
  assert.equal(crowded(packed, 1), true);
  assert.equal(crowded(spaced, 0.5), true, 'labels too small on screen');
});

test('bands cover the map once, each line in one core', () => {
  for (const [H, bh] of [[1216, 800], [1920, 1280], [800, 800], [5000, 640]]) {
    const bs = bands(H, bh);
    assert.equal(bs[0].core0, 0); assert.equal(bs[bs.length - 1].core1, H);
    bs.forEach((b, k) => {
      assert.ok(b.y0 >= 0 && b.y0 + Math.min(bh, H) <= H);
      if (k) { assert.equal(b.core0, bs[k - 1].core1); assert.ok(b.y0 + 0.15 * bh <= b.core0 + 1); }
      if (k < bs.length - 1) assert.ok(b.core1 <= b.y0 + bh - 0.14 * bh);
    });
  }
});

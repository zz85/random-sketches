# Hanzi Lens: reading Chinese through the camera, in the browser

Hanzi Lens is a small experiment. You point a phone at a Chinese menu, pinyin appears over every character, and tapping a line shows what each word means. Nothing goes to a server. The reading is done by two small neural networks running in a Web Worker, and the words come from a dictionary file served with the page.

## Architecture

```
                         MAIN THREAD (app.js)                          WORKER (worker.js + ocr.js)
 +-----------+     +--------------------------------------+      +--------------------------------------+
 | camera    |---->| live loop (every ~60 ms when idle)   |      |                                      |
 | getUser-  |     |  createImageBitmap(video) -----------+----->| 'frame' {detLong:640, read:false}    |
 | Media     |     |                                      |      |   bitmap -> RGBA (OffscreenCanvas)   |
 +-----------+     |  track(): match lines by IoU > 0.3   |      |   resize to det size (x32)           |
                   |   new / grown / missed (drop after 3)|      |   detTensor: BGR, ImageNet norm      |
 +-----------+     |  steady? (moved < 0.6% of diagonal,  |      |   det.onnx (PP-OCRv5 mobile, 4.8 MB) |
 | photo /   |     |           2 frames running)          |      |   dbBoxes: flood fill, hull,         |
 | paste /   |--+  |     yes -> 'read' up to 4 new lines -+----->|     min-area rect, unclip 1.5        |
 | drop      |  |  |                                      |<-----+   readingOrder                       |
 +-----------+  |  +--------------------------------------+      |   keeps the full-res frame for       |
                |  +--------------------------------------+      |   later 'read' calls                 |
 +-----------+  +->| freeze (shutter / photo)             |      |                                      |
 | shutter   |---->|  'frame' {detLong:1280, read:true} --+----->| 'read' / read:true, per line:        |
 +-----------+     +--------------------------------------+      |   recTensor: sample along the quad,  |
                                    |                            |     h=48, w padded to x64,           |
                                    v                            |     columns turned 90 deg CCW        |
                   +--------------------------------------+      |   rec.onnx (PP-OCRv5 mobile, 16.5 MB)|
                   | text.js (pure functions)             |<-----+   ctcDecode: text, confidence,       |
                   |  segment: DP over CC-CEDICT words    |      |     each char's position 0..1        |
                   |  bestEntry: reading from the word    |      +------------------+-------------------+
                   |  readNumber / readTime               |                         |
                   |  spans: reading + chars it covers    |               ONNX Runtime Web 1.31
                   +------------------+-------------------+               WebGPU EP, else WASM EP
                                      |
                                      v
                   +--------------------------------------+
                   | draw(): SVG outlines + pinyin divs   |
                   |  placed at CTC positions, sized to   |
                   |  the width of the chars they cover   |
                   | sheet: ruby line, words, meanings,   |
                   |  speechSynthesis zh-CN, copy, list   |
                   +--------------------------------------+

 ASSETS                                               sw.js
 dict/cedict.txt.gz  (local, 3.9 MB, 125k entries) -> precached with the app shell
 models (Hugging Face, pinned commit)              -> cache-first, kept across updates
 onnxruntime-web (jsDelivr, pinned version)        -> cache-first, kept across updates
```

## Why PaddleOCR

It started as a look at the current state of Tesseract. Tesseract.js is still maintained (v7 added a faster relaxed-SIMD build), but it's still a CPU-only LSTM engine that struggles with photos and vertical text. For Chinese, Baidu's PaddleOCR models are a better fit. mrdoob's [Izakaya Yomi](https://github.com/mrdoob/izakaya-yomi) had already shown that PP-OCRv5 mobile runs well in a browser on Japanese menus. Hanzi Lens follows the same plan for Chinese: PP-OCRv5 for the text, then a language layer for readings and meanings.

## Two models, and the plain JS around them

PP-OCRv5 has two stages, and each one is a single ONNX file:

- **The detector** (4.8 MB) takes the image and returns, for every pixel, the probability that it's part of text.
- **The recogniser** (16.5 MB) takes one line of text, 48 pixels high, and returns a probability over about 18,000 characters for each column step.

Neither stage gives you text on its own. Everything between and after the models is ordinary code in `ocr.js`, with no OpenCV and no other dependencies.

**Detector input.** Paddle trained on BGR images normalised with the ImageNet mean and standard deviation, and both sides must be multiples of 32. Getting the channel order wrong doesn't throw an error. You just get worse boxes, which is the kind of mistake that takes a while to find.

**From probabilities to boxes.** This is DB ("differentiable binarisation") post-processing. Threshold the map at 0.3 and flood-fill the connected regions. Drop a region whose mean probability is under 0.6. Take the convex hull of its boundary pixels and fit the minimum-area rectangle with rotating calipers. The model predicts a shrunk kernel of each line, so the rectangle is then grown by the unclip distance, area × 1.5 / perimeter. A box at least 1.5 times taller than it is wide is treated as a vertical column.

**From a box to a line image.** Instead of cropping and rotating with a canvas, `recTensor` samples the image directly along the box's two edge vectors, using bilinear taps plus a 2×2 supersample when it shrinks a lot. A vertical column runs down its first edge, so it comes out turned 90° counter-clockwise, which is how PP-OCRv5 was trained on vertical text. The width is padded to a multiple of 64, so WebGPU sees a handful of input shapes rather than a new one for every line.

**From the recogniser's output to text.** This is greedy CTC decoding: take the best class at each step, merge repeats, and drop blanks. The useful by-product is position. Each decoded character covers a run of time steps, and the middle of that run is where the character sits along the line. That's how the pinyin can sit over the right character without any per-character detection.

## Words decide the reading

Many common characters have more than one reading. 行 is *xíng* in 行走 (to walk) and *háng* in 银行 (bank). Reading character by character gets these wrong, so `text.js` splits each run of characters into dictionary words first.

The splitter is a dynamic program over CC-CEDICT's 125,000 entries. Each candidate split scores the sum of its word lengths squared, so fewer, longer words win: 宫保鸡丁 stays one word rather than four characters. The reading then comes from the chosen word's entry.

A character left on its own takes its most common reading. For the frequent polyphones (的 *de*, 了 *le*, 和 *hé*, and so on) that comes from a short table. Otherwise it comes from a scoring rule that prefers the entry with the most real senses, and passes over surnames, "variant of", and "used in" pointers.

Menus are full of numbers, and a dictionary doesn't help with those, so they have their own reader. 28 is *èrshíbā*. 105 is *yībǎi líng wǔ*. 2000 is *liǎngqiān*, using 两 rather than 二. Times are read as times: 10:00 is *shí diǎn*. Before I added that, 10:00 came out as two separate numbers with a colon between them.

## Placing the pinyin

The first version gave each syllable a fixed font size. On a line like 营业时间 10:00, the labels ran into each other, because *èrshíyīdiǎn* is much wider than the two digits under it. Now `annotate` returns *spans*, each one a reading plus the characters it covers. Each label is sized to fit the width of its own span, using the CTC positions. Single characters get one syllable each, and a whole number gets one label.

## Live view without flicker

Running the full pipeline on every frame would be slow on a phone, and the labels would jump around as the reading changed from frame to frame. So the live view splits the work:

- **Find lines on every frame,** cheaply. Each frame goes to the detector at 640 pixels on the long side.
- **Track the lines.** Boxes are matched to the previous frame's by overlap (IoU above 0.3, same orientation). A track that misses 3 frames is dropped.
- **Read only when the camera is still and something is new.** The camera counts as steady once the matched boxes have moved less than 0.6% of the frame diagonal for 2 frames running. Then up to 4 tracks with no text yet are read from the full-resolution frame, which the worker keeps from the detection pass. A line that grows by 25%, because more of it came into view, is read again.
- **Keep the text.** A line's text stays attached to its track, so its pinyin follows the line as the camera moves instead of being recomputed.

Pressing the shutter is the accurate path. It runs the detector at 1280 pixels and reads every line.

## Offline

The app shell and the dictionary are precached by the service worker. The models and ONNX Runtime come from Hugging Face and jsDelivr, pinned to an exact commit and version, so it's safe to serve them cache-first for good. After one visit, the camera works with the network off. The smoke test checks this by reloading with the network disabled.

## Numbers

These come from headless Chromium on the CPU (WASM) backend, reading `sample.jpg`, a rendered photo of a menu card tilted 2.5°:

- **Accuracy:** 15 of 15 lines found, with 0 character errors in 64, and the vertical 欢迎光临 read as a column.
- **Freeze:** about 1.7 s for the whole frame. The first run took about 3 s including loading the models.
- **Live:** about 390 ms per frame on CPU, of which reading new lines took about 200 ms. Eight lines had text after 4 frames.
- **Dictionary:** parsing CC-CEDICT took 250 ms in Node.

WebGPU, real phones and real photos are still untested, and that's the next thing to measure.

## What's missing

- **Tone sandhi.** Readings are dictionary tones. 不 before a fourth tone should be *bú*, and 一 changes too, but neither is applied yet.
- **Rare characters.** The mobile recogniser misses some, as Izakaya Yomi's README notes for Japanese. The larger server recogniser would probably do better, at about 4 times the size.
- **Sentence translation.** The plan is Chrome's built-in Translator API where it exists, with a small translation model as the fallback. Even then, the word breakdown stays, because that's what teaches you to read.

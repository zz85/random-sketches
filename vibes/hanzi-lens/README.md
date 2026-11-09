# Hanzi Lens 读

Point the camera at Chinese text and see the pinyin over every character. Tap a line for
its words, each with its pinyin and English meanings from CC-CEDICT. Built for menus and
signs: short lines, prices, vertical columns.

Everything runs on the device in the browser, nothing is uploaded, and after the first
visit it works offline. There is no sentence translation yet: the app gives readings and
dictionary meanings word by word. Technical write-up and architecture diagram in [BLOG.md](BLOG.md).

```
python3 -m http.server              # any static server, from vibes/, then open /hanzi-lens/
node --test                         # pinyin, numbers, words, DB boxes, CTC decoding, vertical crops (13 tests)
node smoke.js                       # headless Chromium: the sample through the real UI and models, sheet,
                                    # live camera on a fake video, offline reload (16 checks)
node tools/build-cedict.mjs [file]  # rebuild dict/cedict.txt.gz from the current CC-CEDICT release
node tools/make_sample.mjs          # rebuild sample.jpg and sample.json (its text)
node tools/make_icons.mjs           # icon.svg -> icon-192.png, icon-512.png
```

`smoke.js` and the tools use headless Chromium (`CHROME=/path/to/chrome`, Playwright's
build by default). The smoke test needs the network on its first run to fetch the models.

## Using it

- **Start camera**: lines of text get an outline, and once the picture holds still for a
  moment their pinyin appears over each character. A line keeps its pinyin while it stays
  in view.
- **Shutter** (or space): freezes the picture and reads all of it at a higher resolution.
  Tap a line to open its words. Tap a word for every meaning and reading it has, and for
  each of its characters on its own. The speaker button reads the line aloud (the browser's Chinese voice),
  the copy button copies it, ☰ (or `l`) lists all the text with pinyin. Shutter again goes back to live.
- **Open a photo** (⇪ or `o`), paste or drop an image: the same frozen view.
- On a dense page, such as a full menu where the lines touch, only the line you tap gets
  pinyin, so the labels don't cover the text. `?dense=1` or `?dense=0` forces it either way.
- **拼** (or `p`) switches between pinyin and outlines only.
- `?ep=wasm` forces the CPU backend instead of WebGPU.

## How it works

1. **Find lines**: [PP-OCRv5 mobile det](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx)
   gives a text probability map. `ocr.js` does the DB post-processing: connected regions,
   minimum-area rectangles, the unclip offset. A box at least 1.5x taller than it is wide is
   a vertical column.
   In a dense grid (rows spaced like the characters in a row) the detector joins rows into
   columns; when it finds columns, a second pass on the image stretched 1.5x vertically
   separates the rows, and its lines replace each column that two or more of them cross.
2. **Read lines**: [PP-OCRv5 mobile rec](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx)
   reads each line, sampled straight out of the image along its rotated box (vertical
   columns turned 90° counter-clockwise, as the model was trained on them). CTC decoding
   also gives each character's position along the line, which places its pinyin.
3. **Words and pinyin** (`text.js`): each run of characters is split into CC-CEDICT words by
   dynamic programming (fewer, longer words win), so the word decides the reading of a
   polyphonic character (银行 yínháng, 行走 xíngzǒu). A character on its own takes its
   common reading. Prices and times are read out (28元 èrshíbā yuán, 10:00 shídiǎn).
4. **Live view**: frames go to the detector at 640 px a few times a second. Lines are
   matched from frame to frame by overlap; once the picture is steady, new lines (and lines
   that grew as more came into view) are read from the full-resolution frame.

The models run in a worker on [ONNX Runtime Web](https://onnxruntime.ai/), WebGPU when the
device has it and WASM otherwise. The models (21 MB) come from Hugging Face and ONNX Runtime
(15–29 MB of WASM) from jsDelivr, both pinned to exact versions in `assets.js`; the
service worker keeps them, so they download once.

On the sample (`sample.jpg`, a rendered menu photo) it reads all 15 lines with no character
errors, on CPU in about 1.7 s for the whole frame.

## Known limitations

- Only tested headless on the CPU backend and a rendered sample. Speed on phones, the
  WebGPU path and real menu photos are untested.
- The mobile recogniser misses rare characters and struggles with calligraphy.
- Pinyin uses dictionary tones. Tone sandhi (不 before a fourth tone, 一) isn't applied.
- No zoom in the frozen view yet.

## Licenses

- PP-OCRv5 models: Apache 2.0 (PaddlePaddle), fetched from Hugging Face
- ONNX Runtime Web: MIT, fetched from jsDelivr
- `dict/cedict.txt.gz`: [CC-CEDICT](https://cc-cedict.org/) (MDBG), CC BY-SA 4.0, reformatted
  by `tools/build-cedict.mjs` and distributed under the same license

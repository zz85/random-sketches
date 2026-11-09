// Builds dict/cedict.txt.gz from CC-CEDICT (CC BY-SA 4.0, MDBG).
//   node tools/build-cedict.mjs [path/to/cedict_1_0_ts_utf-8_mdbg.txt.gz]
// Without a path it downloads the current release from mdbg.net.
// Output: one entry per line, "traditional\tsimplified\tpinyin\tdefinition/definition/...",
// simplified left empty when it is the same as traditional. Header lines start with '#'.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const URL_ = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz';

const src = process.argv[2]
  ? fs.readFileSync(process.argv[2])
  : Buffer.from(await (await fetch(URL_)).arrayBuffer());
const text = zlib.gunzipSync(src).toString('utf8');

let date = '';
const out = [];
for (const line of text.split('\n')) {
  if (line.startsWith('#')) { const m = /^#! date=(.*)/.exec(line); if (m) date = m[1].trim(); continue; }
  const m = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/.exec(line);
  if (!m) continue;
  const [, trad, simp, pinyin, defs] = m;
  out.push(`${trad}\t${simp === trad ? '' : simp}\t${pinyin}\t${defs}`);
}
const header = [
  '# CC-CEDICT, https://cc-cedict.org/ , published by MDBG. ' + (date ? 'Release ' + date + '. ' : ''),
  '# License: Creative Commons Attribution-ShareAlike 4.0, https://creativecommons.org/licenses/by-sa/4.0/',
  '# Modified (reformatted) by tools/build-cedict.mjs; distributed under the same license.',
];
const body = header.join('\n') + '\n' + out.join('\n') + '\n';
const gz = zlib.gzipSync(body, { level: 9 });
fs.writeFileSync(path.join(DIR, 'dict', 'cedict.txt.gz'), gz);
console.log(`${out.length} entries, ${(gz.length / 1e6).toFixed(2)} MB -> dict/cedict.txt.gz (${date})`);

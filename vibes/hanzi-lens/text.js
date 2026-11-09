/*
 * text.js - what a recognised line of Chinese says: words, pinyin and dictionary entries.
 *
 * Words come from CC-CEDICT itself: each run of Han characters is split by dynamic
 * programming into dictionary words, preferring fewer, longer words (score = sum of
 * length squared). Pinyin comes from the chosen word's entry, so context picks the reading
 * of a polyphonic character (银行 yínháng, 行走 xíngzǒu). A character left on its own takes
 * its most common reading: a short table for the frequent polyphones, and otherwise the
 * entry with the most senses that isn't a surname, a variant or a "used in" pointer.
 * Arabic numbers (prices) are read out in Mandarin (28 -> èrshíbā).
 *
 * Pure functions, no DOM: tested in text.test.js.
 */

// ---- dictionary ----

/** Parse dict/cedict.txt.gz's text (see tools/build-cedict.mjs) into a lookup. */
export function parseDict(text) {
  const map = new Map();
  let maxLen = 1, count = 0;
  const add = (key, e) => {
    const list = map.get(key);
    if (list) list.push(e); else map.set(key, [e]);
    const n = [...key].length;
    if (n > maxLen) maxLen = n;
  };
  let i = 0;
  while (i < text.length) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = text.length;
    if (text.charCodeAt(i) !== 35 /* # */ && j > i) {
      const line = text.slice(i, j);
      const a = line.indexOf('\t'), b = line.indexOf('\t', a + 1), c = line.indexOf('\t', b + 1);
      const trad = line.slice(0, a), simp = line.slice(a + 1, b) || trad;
      const e = { trad, simp, pinyin: line.slice(b + 1, c), defs: line.slice(c + 1).split('/') };
      add(simp, e);
      if (trad !== simp) add(trad, e);
      count++;
    }
    i = j + 1;
  }
  return { map, maxLen: Math.min(maxLen, 12), count, get: (w) => map.get(w) || null, has: (w) => map.has(w) };
}

// ---- pinyin ----

const MARKS = { a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', ü: 'ǖǘǚǜ' };

/** One CEDICT syllable ("lu:4", "Zhong1", "r5") with a tone mark ("lǜ", "Zhōng", "r"). */
export function markSyllable(syl) {
  const m = /^([A-Za-zü:]+?)([1-5])$/.exec(syl);
  if (!m) return syl.replace(/u:/g, 'ü').replace(/U:/g, 'Ü');
  const s = m[1].replace(/u:|v/g, 'ü').replace(/U:|V/g, 'Ü');
  const tone = +m[2];
  if (tone === 5) return s;
  const low = s.toLowerCase();
  // the tone goes on a or e; on the o of ou; otherwise on the last vowel
  let at = low.search(/[ae]/);
  if (at < 0) at = low.indexOf('ou');
  if (at < 0) for (let k = low.length - 1; k >= 0; k--) if ('iouü'.includes(low[k])) { at = k; break; }
  if (at < 0) return s;
  const v = low[at], mark = MARKS[v][tone - 1];
  return s.slice(0, at) + (s[at] === v ? mark : mark.toUpperCase()) + s.slice(at + 1);
}

/** "zhong1 guo2" -> ["zhōng", "guó"]. */
export const markPinyin = (p) => p.trim().split(/\s+/).filter(Boolean).map(markSyllable);

/** Syllables of one word written together, with an apostrophe before a, e, o: nǚ'ér, Xī'ān. */
export const joinPinyin = (syls) => syls.map((s, k) => (k && /^[aeoāáǎàēéěèōóǒò]/i.test(s) ? "'" + s : s)).join('');

// Readings of frequent polyphonic characters when they stand alone as a word.
const SOLO = {
  的: 'de5', 了: 'le5', 着: 'zhe5', 得: 'de5', 地: 'di4', 和: 'he2', 为: 'wei4', 爲: 'wei4', 為: 'wei4', 都: 'dou1',
  还: 'hai2', 還: 'hai2', 长: 'chang2', 長: 'chang2', 行: 'xing2', 重: 'zhong4', 好: 'hao3', 乐: 'le4', 樂: 'le4',
  要: 'yao4', 只: 'zhi3', 种: 'zhong3', 種: 'zhong3', 大: 'da4', 中: 'zhong1', 一: 'yi1', 不: 'bu4', 会: 'hui4',
  會: 'hui4', 少: 'shao3', 分: 'fen1', 便: 'bian4', 看: 'kan4', 数: 'shu4', 數: 'shu4', 当: 'dang1', 當: 'dang1',
  没: 'mei2', 沒: 'mei2', 发: 'fa1', 發: 'fa1', 干: 'gan1', 乾: 'gan1', 幹: 'gan4', 觉: 'jue2', 覺: 'jue2',
  相: 'xiang1', 应: 'ying1', 應: 'ying1', 说: 'shuo1', 說: 'shuo1', 将: 'jiang1', 將: 'jiang1', 空: 'kong1',
  差: 'cha4', 正: 'zheng4', 处: 'chu4', 處: 'chu4', 传: 'chuan2', 傳: 'chuan2', 调: 'diao4', 調: 'diao4',
  量: 'liang4', 角: 'jiao3', 似: 'si4', 系: 'xi4', 給: 'gei3', 给: 'gei3', 朝: 'chao2', 率: 'lu:4', 参: 'can1',
  參: 'can1', 薄: 'bao2', 卷: 'juan3', 假: 'jia3', 盛: 'sheng4', 转: 'zhuan3', 轉: 'zhuan3', 载: 'zai4', 載: 'zai4',
  散: 'san4', 藏: 'cang2', 难: 'nan2', 難: 'nan2', 结: 'jie2', 結: 'jie2', 间: 'jian1', 間: 'jian1', 兴: 'xing1',
  興: 'xing1', 强: 'qiang2', 強: 'qiang2', 作: 'zuo4', 背: 'bei4', 露: 'lu4', 曲: 'qu3', 几: 'ji3', 幾: 'ji3',
  奇: 'qi2', 炸: 'zha2', 片: 'pian4', 叶: 'ye4', 葉: 'ye4', 尽: 'jin3', 盡: 'jin4', 份: 'fen4',
  吗: 'ma5', 嗎: 'ma5', 呢: 'ne5', 吧: 'ba5', 啊: 'a5', 么: 'me5', 麼: 'me5', 过: 'guo4', 過: 'guo4',
};
const WEAK = /^(surname |(old |archaic |ancient |erroneous )?variant of |used in |see |(Japanese|Korean) variant|abbr\. for |\(archaic\)|\(old\))/;

/** The entry whose reading a word or a lone character most likely has. */
export function bestEntry(word, entries) {
  if (!entries || !entries.length) return null;
  const solo = SOLO[word];
  if (solo) { const e = entries.find((x) => x.pinyin === solo); if (e) return e; }
  let best = null, bestScore = -Infinity;
  for (const e of entries) {
    const strong = e.defs.filter((d) => !WEAK.test(d)).length;
    let score = strong * 2 + e.defs.length * 0.1;
    if (/[A-Z]/.test(e.pinyin[0])) score -= 5;            // proper noun reading
    if (strong === 0) score -= 10;
    if (e.simp !== word && e.trad !== word) score -= 1;
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return best;
}

// ---- numbers ----

const DIGIT = ['líng', 'yī', 'èr', 'sān', 'sì', 'wǔ', 'liù', 'qī', 'bā', 'jiǔ'];
const DIGIT_HAN = '零一二三四五六七八九';

function under10k(n, lead) {   // n in 1..9999 -> syllables
  const out = [], places = [[1000, 'qiān', '千'], [100, 'bǎi', '百'], [10, 'shí', '十'], [1, '', '']];
  let zero = false, started = false;
  for (const [p, py, han] of places) {
    const d = Math.floor(n / p) % 10;
    if (d === 0) { if (started) zero = true; continue; }
    if (zero) { out.push(['líng', '零']); zero = false; }
    // 10-19 at the head of a number are shí, shíyī ... not yīshí
    if (p === 10 && d === 1 && !started && lead) { /* shí */ }
    else if (d === 2 && p === 1000) out.push(['liǎng', '两']);   // 2000 is liǎngqiān
    else out.push([DIGIT[d], DIGIT_HAN[d]]);
    if (py) out.push([py, han]);
    started = true;
  }
  return out;
}

/** A clock time "10:00" / "21:30" -> {pinyin, han}: shí diǎn, èrshíyī diǎn sānshí fēn. */
export function readTime(s) {
  const m = /^(\d{1,2})[:：](\d{2})$/.exec(s);
  if (!m || +m[1] > 24 || +m[2] > 59) return null;
  const h = readNumber(String(+m[1])), parts = { pinyin: [...h.pinyin, 'diǎn'], han: h.han + '点' };
  if (+m[2]) {
    const mm = readNumber(String(+m[2]));
    if (+m[2] < 10) { parts.pinyin.push('líng'); parts.han += '零'; }
    parts.pinyin.push(...mm.pinyin, 'fēn'); parts.han += mm.han + '分';
  }
  return parts;
}

/** Mandarin reading of an Arabic number: "28" -> {pinyin: ["èr","shí","bā"], han: "二十八"}. */
export function readNumber(s) {
  const m = /^(\d+)(?:[.．](\d+))?$/.exec(s.replace(/[,，]/g, ''));
  if (!m) return null;
  const [, int, frac] = m;
  let parts = [];
  const n = Number(int);
  if (int.length > 12 || (int.length > 1 && int[0] === '0')) {
    parts = [...int].map((d) => [DIGIT[+d], DIGIT_HAN[+d]]);   // digit by digit (codes, phone numbers)
  } else if (n === 0) parts = [[DIGIT[0], DIGIT_HAN[0]]];
  else {
    const groups = [[1e8, 'yì', '亿'], [1e4, 'wàn', '万'], [1, '', '']];
    let lead = true, gap = false;
    for (const [g, py, han] of groups) {
      const v = Math.floor(n / g) % 1e4;
      if (v === 0) { if (!lead) gap = true; continue; }
      if (!lead && (gap || v < 1000)) parts.push(['líng', '零']);
      if (v === 2 && py) parts.push(['liǎng', '两']);              // 20000 is liǎngwàn
      else parts.push(...under10k(v, lead));
      if (py) parts.push([py, han]);
      lead = false; gap = false;
    }
  }
  if (frac) { parts.push(['diǎn', '点']); for (const d of frac) parts.push([DIGIT[+d], DIGIT_HAN[+d]]); }
  return { pinyin: parts.map((p) => p[0]), han: parts.map((p) => p[1]).join('') };
}

// ---- segmentation ----

const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3007\u{20000}-\u{3134F}]/u;
export const isHan = (ch) => HAN.test(ch);

function segmentHan(chars, dict) {
  const n = chars.length, score = new Float64Array(n + 1).fill(-Infinity), from = new Int32Array(n + 1);
  score[0] = 0;
  for (let i = 0; i < n; i++) {
    if (score[i] === -Infinity) continue;
    let w = '';
    for (let len = 1; len <= dict.maxLen && i + len <= n; len++) {
      w += chars[i + len - 1];
      if (len > 1 && !dict.has(w)) continue;
      const s = score[i] + len * len;
      if (s > score[i + len]) { score[i + len] = s; from[i + len] = i; }
    }
  }
  const cuts = [];
  for (let k = n; k > 0; k = from[k]) cuts.push(k);
  cuts.push(0);
  cuts.reverse();
  const words = [];
  for (let k = 0; k + 1 < cuts.length; k++) words.push([cuts[k], cuts[k + 1]]);
  return words;
}

/**
 * Split a line into tokens:
 *   { text, kind: 'word'|'number'|'latin'|'punct'|'space', start, end (code point indices),
 *     pinyin: [syllables] | null, entry, entries }
 * plus `charPinyin`, one syllable (or null) per code point of the line, and `spans`, each
 * reading with the characters it covers (one per character, or a whole number), for placing
 * pinyin over the text.
 */
export function annotate(line, dict) {
  const chars = Array.from(line);
  const tokens = [];
  const charPinyin = new Array(chars.length).fill(null);
  const spans = [];   // { from, to, py }: a reading and the characters it covers
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    let j = i + 1;
    if (isHan(ch)) {
      while (j < chars.length && isHan(chars[j])) j++;
      for (const [a, b] of segmentHan(chars.slice(i, j), dict)) {
        const text = chars.slice(i + a, i + b).join('');
        const entries = dict.get(text);
        const entry = bestEntry(text, entries);
        const pinyin = entry ? markPinyin(entry.pinyin) : null;
        tokens.push({ text, kind: 'word', start: i + a, end: i + b, pinyin, entry, entries });
        if (pinyin) {
          if (pinyin.length === b - a) for (let k = 0; k < pinyin.length; k++) { charPinyin[i + a + k] = pinyin[k]; spans.push({ from: i + a + k, to: i + a + k + 1, py: pinyin[k] }); }
          else { charPinyin[i + a] = joinPinyin(pinyin); spans.push({ from: i + a, to: i + b, py: charPinyin[i + a] }); }
        }
      }
    } else if (/[0-9０-９]/.test(ch)) {
      while (j < chars.length && /[0-9０-９.．,，:：]/.test(chars[j])) j++;
      while (j > i + 1 && /[.．,，:：]/.test(chars[j - 1])) j--;          // a trailing full stop isn't a decimal point
      const text = chars.slice(i, j).join('').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace('．', '.');
      if (/[:：]/.test(text) && !readTime(text)) {                   // not a time: read the first number alone
        j = i + text.search(/[:：]/);
      }
      const run = chars.slice(i, j).join('').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace('．', '.');
      const r = readTime(run) || readNumber(run);
      tokens.push({ text: chars.slice(i, j).join(''), kind: 'number', start: i, end: j, pinyin: r ? r.pinyin : null, han: r ? r.han : null, entry: null, entries: null });
      if (r) { charPinyin[i] = joinPinyin(r.pinyin); spans.push({ from: i, to: j, py: charPinyin[i] }); }
    } else if (/[A-Za-zＡ-Ｚａ-ｚ]/.test(ch)) {
      while (j < chars.length && /[A-Za-zＡ-Ｚａ-ｚ'’-]/.test(chars[j])) j++;
      tokens.push({ text: chars.slice(i, j).join(''), kind: 'latin', start: i, end: j, pinyin: null, entry: null, entries: null });
    } else if (/\s/.test(ch)) {
      while (j < chars.length && /\s/.test(chars[j])) j++;
      tokens.push({ text: chars.slice(i, j).join(''), kind: 'space', start: i, end: j, pinyin: null, entry: null, entries: null });
    } else {
      tokens.push({ text: ch, kind: 'punct', start: i, end: j, pinyin: null, entry: null, entries: null });
    }
    i = j;
  }
  return { chars, tokens, charPinyin, spans };
}

/** The pinyin of a whole line, words joined, for reading it at a glance. */
export function linePinyin(ann) {
  const out = [];
  for (const t of ann.tokens) {
    if (t.kind === 'space') continue;
    if (t.pinyin) out.push(joinPinyin(t.pinyin));
    else out.push(t.text);
  }
  return out.join(' ').replace(/ ([,.!?;:，。！？；：、）)])/g, '$1');
}

/** Meanings of a word as shown: the chosen reading first, then the others. */
export function meanings(token) {
  const list = token.entries ? [...token.entries] : [];
  if (token.entry) { list.splice(list.indexOf(token.entry), 1); list.unshift(token.entry); }
  return list.map((e) => ({ trad: e.trad, simp: e.simp, pinyin: markPinyin(e.pinyin).join(' '), defs: e.defs }));
}

// ---- voice ----

/**
 * The speech voice to read Mandarin with, from speechSynthesis.getVoices(): a voice on the
 * device before one a server speaks (the line's text would leave the device), then
 * mainland Mandarin (zh-CN, zh-Hans: the readings shown are mainland ones) before other
 * Mandarin (zh-TW). Cantonese voices (zh-HK, zh-MO, yue) are never chosen. Null when there
 * is no such voice; the utterance's lang then lets the browser choose.
 */
export function pickVoice(voices) {
  let best = null, bestRank = Infinity;
  for (const v of voices || []) {
    const t = (v.lang || '').replace(/_/g, '-').toLowerCase();
    let r;
    if (/^(zh|cmn)(-hans)?(-cn)?$/.test(t) || /^(zh|cmn)-(hans-)?cn\b/.test(t) || /^(zh|cmn)-hans\b/.test(t)) r = 0;
    else if (/^(zh|cmn)-(hant-)?tw\b/.test(t) || /^cmn\b/.test(t)) r = 1;
    else continue;                                         // zh-HK, zh-MO, yue and the rest
    if (v.localService === false) r += 2;                  // spoken by a server
    if (r < bestRank || (r === bestRank && v.default && !best.default)) { best = v; bestRank = r; }
  }
  return best;
}

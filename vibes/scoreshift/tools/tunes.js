// Test tunes for the fixture builder. Each covers different clefs, keys, ledger lines,
// accidentals, chords and rhythms. `clef`/`fifths` are the truth for every staff.
export const TUNES = [
  { name: 'minuet', clef: 'G', fifths: 1, abc: `X:1
M:3/4
L:1/8
K:G
d2 GA Bc | d2 G2 G2 | e2 cd ef | g2 G2 G2 | c2 dc BA | B2 cB AG | F2 GA BG | A6 |
d2 GA Bc | d2 G2 G2 | e2 cd ef | g2 G2 G2 | c2 dc BA | B2 cB AG | A2 BA GF | G6 |
b2 ga bg | a2 de fd | g2 ef gd | ^c2 Bc A2 | AB cd ef | g2 f2 e2 | f2 A2 ^c2 | d6 |]` },
  { name: 'flats', clef: 'G', fifths: -2, abc: `X:2
M:4/4
L:1/8
K:Bb
B,D FB d2 f2 | g a b c' d'4 | c'b ag f2 =e2 | f4 z4 |
_e d c B A G F E | D2 F2 B2 d2 | =B c ^c d _e2 =e2 | f8 |
d'c' ba gf ed | c B A G F E D C | B,4 D4 | F2 _A2 =B2 z2 | B8 |]` },
  { name: 'cello', clef: 'F', fifths: 2, abc: `X:3
M:4/4
L:1/8
K:D clef=bass
D,2 F,A, D2 F2 | A2 G F E D C B, | A,4 ^G,4 | A,8 |
B,, D, F, B, D C B, A, | G, F, E, D, C, B,, A,, G,, | F,,4 A,,4 | D,8 |
d c =c B _B A G F | E2 ^D2 E4 | A,2 C2 E2 A2 | d8 |]` },
  { name: 'chords', clef: 'G', fifths: -3, abc: `X:4
M:4/4
L:1/4
K:Eb
[EG] [FA] [GB] [Ac] | [Bd] [ce] [df] [eg] | [EGB] [EGB] [=EG_d] [EG_d] | [FAc] [FAc] [FAc] [FAc] |
[ce] [Bd] [Ac] [GB] | [=A^c] [Bd] [ce] [ce] | [B,EG] [CEA] [DFB] [EGc] | [EGBe] [EGBe] [EGBe] z |]` },
  { name: 'viola', clef: 'C', fifths: 3, abc: `X:5
M:2/4
L:1/16
K:A clef=alto
A,CEA cBAG | F2A2 d2f2 | e4 =c4 | B8 |
c2e2 a2g2 | f e d c B A G F | E4 ^D4 | E8 |
A,2C2 E2A2 | c4 B4 | A8 |]` },
  { name: 'longnotes', clef: 'G', fifths: 0, abc: `X:6
M:4/4
L:1/4
K:C
G,4 | A,2 B,2 | C D E F | G2 z2 | a4 | b2 c'2 | d' c' b a | g2 z2 |
^F2 G2 | _B2 A2 | =B4 | c4 | e'2 c'2 | a2 f2 | z G2 G | c4 |]` },
  { name: 'sharpkeys', clef: 'G', fifths: 4, abc: `X:7
M:6/8
L:1/8
K:E
EGB egb | afd B3 | ^^cde =cBA | G3 E3 |
Bcd efg | a2g f2e | def =gfe | e6 |
EFG ABc | =d2c B2A | GAB cde | e6 |]` },
  // rhythm tunes are written in a compact notation (see toMEI below), not ABC: Verovio's
  // ABC importer drops quarter-note triplets and chord lengths.
  // rests of every value, dotted values, flags vs beams, ties
  { name: 'rests', clef: 'G', fifths: -1, meter: [4, 4], src: `
c5:4 r:4 [a4:8 r:8] f4:4 | f5:4. e5:8 d5:4 r:4 | c5:8 bb4:8 a4:8 g4:8 f4:8 r:8 r:4 | r:2 f4:2 |
[c5:8. d5:16] [a4:16 b4:16 nb4:16 c5:16] d5:2 | r:1 | g5:4~ [g5:8 f5:8] [e5:8 d5:8] c5:4 | r:8 a4:8 r:16 a4:16 c5:16 r:16 c5:4 r:4 |
f5:2. r:4 | f4:1 |` },
  // triplets (eighth and quarter), cut time, ties across the barline, chords
  { name: 'triplets', clef: 'G', fifths: 2, meter: [2, 2], sym: 'cut', src: `
3{[d4:8 e4:8 f4:8]} 3{[g4:8 a4:8 b4:8]} d5:4 f5:4 | 3{d5:4 c5:4 b4:4} a4:2 | a5:4. g5:8 [f5:8 e5:8] (d5 f5):4 | (d5 a5):2 r:2 |
3{[f5:8 e5:8 d5:8]} 3{[c5:8 b4:8 a4:8]} g4:4 r:4 | f4:4 a4:4 3{d5:4 e5:4 f5:4} | g5:1~ | g5:2 r:4 a4:4 | d5:1 |` },
  // compound meter with a pickup, bass clef, dotted rests, 32nds
  { name: 'sixeight', clef: 'F', fifths: -3, meter: [6, 8], src: `
b2:8 | e3:4 g3:8 b3:4 g3:8 | e4:4. d4:4. | [c4:16. b3:32 a3:8] g3:4 r:4 | f3:4. r:4. |
[e3:16 f3:16 g3:16 a3:16 b3:16 c4:16] d4:4 f3:8 | [b3:8 a3:8 g3:8] e3:4. | (g3 b3 e4):4. g4:4 r:8 | e4:2. |` },
  // two voices on one staff (stems up / down), against each other in rhythm, rests in one voice
  { name: 'twovoice', clef: 'G', fifths: 1, meter: [4, 4], src: `
d5:4 e5:4 f5:4 g5:4 & b4:2 a4:2 | [a5:8 g5:8 f5:8 e5:8] d5:2 & c5:4 b4:4 a4:2 | g5:2. f5:4 & r:4 b4:4 c5:4 d5:4 |
e5:4 d5:4 c5:2 & g4:1 | b4:2 d5:2 & g4:4 g4:4 f4:2 | e5:4. d5:8 c5:4 b4:4 & r:2 a4:2 |
c5:2 b4:4 a4:4 & e4:2 g4:2 | b4:1 & g4:1 |` },
  // double sharps and flats, staccato, tenuto, accents on both stem directions and in beams
  { name: 'marks', clef: 'G', fifths: 0, meter: [4, 4], src: `
xf4:4! xg4:4! bbb4:4_ bbe5:4_ | [c5:8! d5:8! e5:8! f5:8!] xc5:2> | [g4:8_ a4:8_] b4:4> xd5:4! r:4 | bba4:2_ xf5:2! |
e5:4> d5:4> [c5:8! b4:8!] a4:4_ | xg5:4! bbd5:4 xa4:4 bbg4:4 | [f5:8! e5:8! d5:8! c5:8!] b4:4_ g4:4> | c5:1 |` },
  // dynamics, slurs (within a bar, across a barline and over a system break) and hairpins
  { name: 'expr', clef: 'G', fifths: -1, meter: [3, 4], src: `
f4:4@p^ g4:4 a4:4$ | b4:2^@mf c5:4$ | d5:4+< e5:4 f5:4+. | g5:2.@f | a5:4^ g5:4 f5:4 | e5:4 d5:4 c5:4$ |
d5:4@mp+> c5:4 b4:4 | a4:2.+.@pp | g4:4^ a4:4 b4:4$ | c5:4@sf d5:4 c5:4 | b4:4^ a4:4 g4:4$ | f4:2.@ff |` },
  // grace notes: slashed acciaccaturas (as in the CODA waltz) and appoggiaturas, slurred into
  // their note, on the beat and before notes with accidentals, above and below
  { name: 'grace', clef: 'G', fifths: 2, meter: [3, 4], src: `
g~a5:8^ g5:4$ f5:4 e5:4 | g~e5:8^ d5:4$ c5:4 b4:4 | g=b4:8^ a4:2$ d5:4 | g~f4:8^ g4:4$ g~b4:8^ a4:4$ g4:4 |
[g~e5:8^ #d5:8$ e5:8 f5:8 g5:8 e5:8 d5:8] | g=c5:16^ b4:2.$ | g~e4:8^ d4:4$ f4:4 a4:4 | d5:2. |` },
];

export const FONTS = ['Leipzig', 'Bravura', 'Leland', 'Gootville', 'Petaluma'];
// SMuFL glyphs we need: noteheads, accidentals, clefs.
export const GLYPHS = { E0A2: 'noteheadWhole', E0A3: 'noteheadHalf', E0A4: 'noteheadBlack', E262: 'sharp', E260: 'flat', E261: 'natural', E263: 'doubleSharp', E264: 'doubleFlat', E050: 'gClef', E062: 'fClef', E05C: 'cClef',
  // rhythm: rests, flags, time signature digits, tuplet digits
  E4E3: 'restWhole', E4E4: 'restHalf', E4E5: 'restQuarter', E4E6: 'rest8th', E4E7: 'rest16th', E4E8: 'rest32nd',
  E240: 'flag8thUp', E241: 'flag8thDown', E242: 'flag16thUp', E243: 'flag16thDown', E244: 'flag32ndUp', E245: 'flag32ndDown',
  E080: 'timeSig0', E081: 'timeSig1', E082: 'timeSig2', E083: 'timeSig3', E084: 'timeSig4', E085: 'timeSig5', E086: 'timeSig6', E087: 'timeSig7', E088: 'timeSig8', E089: 'timeSig9',
  E08A: 'timeSigCommon', E08B: 'timeSigCutCommon', E883: 'tuplet3', E885: 'tuplet5', E886: 'tuplet6' };
// one tune per clef: mid-tune clef changes are engraved with the smaller change-clef glyphs
export const GLYPH_ABC = [
  `X:9\nM:4/4\nL:1/8\nK:C\n^c8 | _c4 =c4 | ^^c2 __c2 c c c c |]`,
  `X:9\nM:4/4\nL:1/8\nK:C clef=bass\nC,8 |]`,
  `X:9\nM:4/4\nL:1/8\nK:C clef=alto\nc8 |]`,
];
// MEI sources (compact notation) for the rhythm glyphs: every rest, flag, digit, C and cut C
const G = (meter, src, sym) => ({ clef: 'G', fifths: 0, meter, sym, src });
export const GLYPH_TUNES = [
  G([3, 4], `r:1 | r:2 r:4 r:8 r:16 r:32 r:32 | c4:8 c4:16 c4:32 a5:8 a5:16 a5:32 | 3{[c5:8 c5:8 c5:8]} r:4 |`),
  G([10, 8], `r:1 |`), G([2, 2], `r:1 |`), G([5, 16], `r:1 |`), G([7, 8], `r:1 |`), G([9, 8], `r:1 |`),
  G([4, 4], `r:1 |`, 'common'), G([2, 2], `r:1 |`, 'cut'),
  G([4, 4], `5{[c5:16 c5:16 c5:16 c5:16 c5:16]} 6{[c5:16 c5:16 c5:16 c5:16 c5:16 c5:16]} r:2 |`),
];

// Compact notation -> MEI for Verovio. A bar may hold two voices: 'voice 1 tokens & voice 2 tokens'.
// After a value: ! staccato, _ tenuto, > accent (c5:4! [d5:8_ e5:8>]). Tokens: pitch [accidental # b n x bb] letter octave,
// ':' duration (1 2 4 8 16 32) and dots, '~' tie to the next note, r = rest, (a b c):d chord,
// [ ... ] beam group, 3{ ... } triplet, | barline. A first measure shorter than the meter is a pickup.
const ACC = { '#': 's', b: 'f', n: 'n', x: 'x', bb: 'ff' };
export function toMEI(t) {
  const clef = { G: ['G', 2], F: ['F', 4], C: ['C', 3] }[t.clef];
  const ks = t.fifths ? `${Math.abs(t.fifths)}${t.fifths > 0 ? 's' : 'f'}` : '0';
  const meter = `<meterSig count="${t.meter[0]}" unit="${t.meter[1]}"${t.sym ? ` sym="${t.sym}"` : ''}/>`;
  const cap = (t.meter[0] * 4) / t.meter[1];
  let tied = new Set();
  const note = (p, dur, dots, tie, inChord) => {
    const m = p.match(/^(bb|#|b|n|x)?([a-g])(\d)$/); if (!m) throw new Error('bad pitch ' + p);
    const key = m[2] + m[3], tv = tie ? (tied.has(key) ? 'm' : 'i') : tied.has(key) ? 't' : null;
    if (tie) tied.add(key); else tied.delete(key);
    return `<note pname="${m[2]}" oct="${m[3]}"${inChord ? '' : ` dur="${dur}"${dots ? ` dots="${dots}"` : ''}`}${m[1] ? ` accid="${ACC[m[1]]}"` : ''}${tv ? ` tie="${tv}"` : ''}/>`;
  };
  const len = (dur, dots) => { let q = 4 / dur, a = q; for (let i = 0; i < dots; i++) { a /= 2; q += a; } return q; };
  const bars = t.src.trim().split('|').map((b) => b.trim()).filter(Boolean);
  // voices: a bar may hold layers separated by '&' (layer 1 stems up, layer 2 stems down)
  const layer = (src) => {
    let x = '', q = 0, tup = 1;
    const toks = src.replace(/\(([^)]*)\)/g, (_, c) => c.trim().split(/\s+/).join(',')).replace(/(\d)\{/g, ' $1{ ').replace(/([[\]}])/g, ' $1 ').split(/\s+/).filter(Boolean);
    for (const tk of toks) {
      if (tk === '[') { x += '<beam>'; continue; } if (tk === ']') { x += '</beam>'; continue; }
      if (/^\d\{$/.test(tk)) { x += `<tuplet num="${tk[0]}" numbase="2" num.visible="true" bracket.visible="false">`; tup = 2 / +tk[0]; continue; }
      if (tk === '}') { x += '</tuplet>'; tup = 1; continue; }
      const m = tk.match(/^([^:]+):(\d+)(\.*)(~?)(.*)$/); if (!m) throw new Error('bad token ' + tk);
      const dur = +m[2], dots = m[3].length, tie = !!m[4];
      // suffixes: ! staccato, _ tenuto, > accent, @pp dynamic, ^ $ slur start / end,
      // +< +> hairpin start (cresc / dim), +. hairpin end
      const suf = m[5], ar = [...suf.replace(/@[a-z]+|\+[<>.]|[\^$]/g, '')].map((c) => ({ '!': 'stacc', _: 'ten', '>': 'acc' })[c]).filter(Boolean).join(' ');
      const id = 'n' + ++nid;
      const dyn = suf.match(/@([a-z]+)/); if (dyn) ctl.push({ bar: cur, kind: 'dynam', id, text: dyn[1] });
      if (suf.includes('^')) open.slur = { bar: cur, id };
      if (suf.includes('$') && open.slur) { ctl.push({ bar: open.slur.bar, kind: 'slur', start: open.slur.id, end: id }); open.slur = null; }
      const hp = suf.match(/\+([<>.])/);
      if (hp && hp[1] !== '.') open.hp = { bar: cur, id, form: hp[1] === '<' ? 'cres' : 'dim' };
      if (hp && hp[1] === '.' && open.hp) { ctl.push({ bar: open.hp.bar, kind: 'hairpin', start: open.hp.id, end: id, form: open.hp.form }); open.hp = null; }
      const d = ` dur="${dur}"${dots ? ` dots="${dots}"` : ''}${ar ? ` artic="${ar}"` : ''}`;
      q += len(dur, dots) * tup;
      // a grace note: g~e5:8 (slashed acciaccatura) or g=e5:8 (appoggiatura); takes no time
      const gm = m[1].match(/^g([~=])(.+)$/);
      if (gm) { q -= len(dur, dots) * tup; x += note(gm[2], dur, 0, false, false).replace('<note ', `<note xml:id="${id}" grace="${gm[1] === '~' ? 'unacc' : 'acc'}" stem.dir="up" `); if (suf.includes('^')) open.slur = { bar: cur, id }; continue; }
      if (m[1] === 'r') x += `<rest xml:id="${id}"${d}/>`;
      else if (m[1].includes(',')) x += `<chord xml:id="${id}"${d}>${m[1].split(',').map((p) => note(p, dur, dots, tie, true)).join('')}</chord>`;
      else x += note(m[1], dur, dots, tie, false).replace('<note ', `<note xml:id="${id}" ${ar ? `artic="${ar}" ` : ''}`);
    }
    return { x, q };
  };
  let nid = 0, cur = 0; const ctl = [], open = {};
  const ctlXml = (bi) => ctl.filter((c) => c.bar === bi).map((c) => c.kind === 'dynam' ? `<dynam staff="1" startid="#${c.id}">${c.text}</dynam>`
    : c.kind === 'slur' ? `<slur staff="1" startid="#${c.start}" endid="#${c.end}"/>` : `<hairpin form="${c.form}" staff="1" startid="#${c.start}" endid="#${c.end}"/>`).join('');
  const built = bars.map((bar, bi) => {
    cur = bi;
    const ls = bar.split('&').map((v) => layer(v.trim()));
    const pickup = bi === 0 && Math.abs(ls[0].q - cap) > 1e-6;
    return [bi, `<measure n="${bi + 1}"${pickup ? ' metcon="false"' : ''}${bi === bars.length - 1 ? ' right="end"' : ''}><staff n="1">${ls.map((l, k) => `<layer n="${k + 1}">${l.x}</layer>`).join('')}</staff>`];
  });
  const out = built.map(([bi, x]) => x + ctlXml(bi) + '</measure>');
  return `<?xml version="1.0" encoding="UTF-8"?><mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><music><body><mdiv><score><scoreDef><staffGrp><staffDef n="1" lines="5"><clef shape="${clef[0]}" line="${clef[1]}"/><keySig sig="${ks}"/>${meter}</staffDef></staffGrp></scoreDef><section>${out.join('')}</section></score></mdiv></body></music></mei>`;
}

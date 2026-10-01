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
[EG] [FA] [GB] [Ac] | [Bd] [ce] [df] [eg] | [EGB]2 [=EG_d]2 | [FAc]4 |
[ce] [Bd] [Ac] [GB] | [=A^c] [Bd] [ce]2 | [B,EG] [CEA] [DFB] [EGc] | [EGBe]4 |]` },
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
];

export const FONTS = ['Leipzig', 'Bravura', 'Leland', 'Gootville', 'Petaluma'];
// SMuFL glyphs we need: noteheads, accidentals, clefs.
export const GLYPHS = { E0A2: 'noteheadWhole', E0A3: 'noteheadHalf', E0A4: 'noteheadBlack', E262: 'sharp', E260: 'flat', E261: 'natural', E263: 'doubleSharp', E264: 'doubleFlat', E050: 'gClef', E062: 'fClef', E05C: 'cClef' };
// one tune per clef: mid-tune clef changes are engraved with the smaller change-clef glyphs
export const GLYPH_ABC = [
  `X:9\nM:4/4\nL:1/8\nK:C\n^c8 | _c4 =c4 | ^^c2 __c2 c c c c |]`,
  `X:9\nM:4/4\nL:1/8\nK:C clef=bass\nC,8 |]`,
  `X:9\nM:4/4\nL:1/8\nK:C clef=alto\nc8 |]`,
];

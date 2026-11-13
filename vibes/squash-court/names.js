// Players' names from the score bug, voted across frames. One read of the bug (ocr.js playerNames)
// is right most of the time, and a wrong read usually has a higher error; the vote keeps the last
// few reads of each side and names a side once one spelling clearly leads there.
//
//   const v = new NameVote();
//   v.add(read, t) -> { left, right } | null    read: playerNames' answer, or null for no bug
//   v.names                                     the names in force, { left, right } or null
//
// Each side is voted on its own, so a misread on one side doesn't spoil the other. A read counts
// with weight 0.16 - err when its err is under 0.12 (98% of right reads on PSA bugs, few of the
// wrong ones); a spelling is in force with at least 3 reads and 60% of the weight among the last 8
// counted reads of its side. A new match in a compilation changes the bug, and its names take over
// once they lead in the window. A seek back (t going backwards) or a long run of frames without a
// bug starts afresh.
export const NAME_VOTE = { maxErr: 0.12, wMax: 0.16, window: 8, minReads: 3, minShare: 0.6, forgetS: 120 };

export class NameVote {
  constructor(opt = {}) { this.o = { ...NAME_VOTE, ...opt }; this.reset(); }
  reset() { this.sides = { left: [], right: [] }; this.names = null; this.tLast = null; this.tSeen = null; }
  add(read, t) {
    const o = this.o;
    if (this.tLast != null && t < this.tLast) this.reset();
    this.tLast = t;
    if (!read) { if (this.tSeen != null && t - this.tSeen > o.forgetS) this.reset(); return this.names; }
    this.tSeen = t;
    for (const side of ['left', 'right']) {
      const err = read[side + 'Err'] ?? read.err;
      if (!(err < o.maxErr)) continue;
      const q = this.sides[side]; q.push({ text: read[side], w: o.wMax - err });
      if (q.length > o.window) q.shift();
    }
    const left = this.leader('left'), right = this.leader('right');
    // both sides, and not the same name twice (a bug read off one box)
    if (left && right && left !== right) this.names = { left, right };
    return this.names;
  }
  leader(side) {
    const q = this.sides[side], o = this.o, w = new Map(), n = new Map(); let tot = 0;
    for (const r of q) { w.set(r.text, (w.get(r.text) ?? 0) + r.w); n.set(r.text, (n.get(r.text) ?? 0) + 1); tot += r.w; }
    let best = null; for (const [k, v] of w) if (!best || v > w.get(best)) best = k;
    return best && n.get(best) >= o.minReads && w.get(best) >= o.minShare * tot ? best : null;
  }
}

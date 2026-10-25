// T domination: who holds the T. The T is where the short line meets the half-court line; the
// player who gets back to it between shots controls the rally. Per player:
//   - zone: seconds within `radius` of the T (on its own, whatever the other player does)
//   - control: of the time both players are seen together, the seconds this player is the nearer
//     of the two to the T (the two shares add up to 100 %)
//   - mean distance from the T while seen
// Fed one detection at a time, in time order, as the page's tracker or match.mjs's merged
// detections deliver them. A step back in time (a seek) starts the pairing afresh.
import { W } from './court.js';

export const T_POINT = [W / 2, 5.44]; // back edge of the short line, on the half-court line

export class TControl {
  constructor({ radius = 1.0, pairWindow = 0.25, maxDt = 0.5 } = {}) {
    this.radius = radius; this.pairWindow = pairWindow; this.maxDt = maxDt;
    this.p = {}; this.both = 0; this.lastPair = null;
  }
  stat(id) { return (this.p[id] ??= { seen: 0, zone: 0, control: 0, distSum: 0, last: null }); }
  add(id, t, X) {
    const s = this.stat(id);
    if (s.last && t < s.last.t) { s.last = null; this.lastPair = null; }
    const d = Math.hypot(X[0] - T_POINT[0], X[1] - T_POINT[1]);
    const dt = s.last ? Math.min(this.maxDt, t - s.last.t) : 0;
    if (dt > 0) { s.seen += dt; s.distSum += d * dt; if (d < this.radius) s.zone += dt; }
    s.last = { t, d };
    // pairing: the other player seen within pairWindow of now
    const o = Object.entries(this.p).find(([k, v]) => +k !== +id && v.last && Math.abs(v.last.t - t) <= this.pairWindow);
    if (!o) { this.lastPair = null; return; }
    if (this.lastPair != null && t < this.lastPair) this.lastPair = null;
    const pdt = this.lastPair == null ? 0 : Math.min(this.maxDt, t - this.lastPair);
    this.lastPair = t;
    if (pdt <= 0) return;
    this.both += pdt;
    const [oid, ov] = o; (d <= ov.last.d ? s : this.stat(oid)).control += pdt;
  }
  summary(id) {
    const s = this.p[id]; if (!s) return null;
    return { seconds: s.seen, zoneSeconds: s.zone, zoneShare: s.seen ? s.zone / s.seen : 0, controlSeconds: s.control, controlShare: this.both ? s.control / this.both : null, meanDistance: s.seen ? s.distSum / s.seen : null, radius: this.radius };
  }
  // restore from a summary (a match file opened in the page)
  static fromSummaries(sums) {
    const c = new TControl({ radius: Object.values(sums).find(Boolean)?.radius ?? 1.0 });
    for (const [id, m] of Object.entries(sums)) if (m) { const s = c.stat(id); s.seen = m.seconds; s.zone = m.zoneSeconds; s.control = m.controlSeconds; s.distSum = (m.meanDistance ?? 0) * m.seconds; }
    c.both = Object.values(sums).reduce((a, m) => a + (m?.controlSeconds ?? 0), 0);
    return c;
  }
}

// "T 62%" — or '' before both players have been seen together
export function tLabel(m) { return m && m.controlShare != null ? `T ${(m.controlShare * 100).toFixed(0)}%` : ''; }

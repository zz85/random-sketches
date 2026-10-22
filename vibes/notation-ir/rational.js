// Exact rational time. Durations and onsets are fractions of a whole note:
// quarter = 1/4, dotted eighth = 3/16, triplet eighth = 1/12. Exact arithmetic means a
// triplet plus its siblings sums to a beat with no tick rounding, and any tuplet ratio works.
// Values are frozen { n, d } with d > 0 and gcd(n, d) = 1.

const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; };

export function r(n, d = 1) {
  if (!Number.isInteger(n) || !Number.isInteger(d) || d === 0) throw new Error(`bad rational ${n}/${d}`);
  if (d < 0) { n = -n; d = -d; }
  const g = gcd(n, d);
  return Object.freeze({ n: n / g, d: d / g });
}
export const ZERO = r(0);
export const add = (a, b) => r(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a, b) => r(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a, b) => r(a.n * b.n, a.d * b.d);
export const div = (a, b) => r(a.n * b.d, a.d * b.n);
export const cmp = (a, b) => a.n * b.d - b.n * a.d;
export const eq = (a, b) => a.n === b.n && a.d === b.d;
export const lt = (a, b) => cmp(a, b) < 0;
export const le = (a, b) => cmp(a, b) <= 0;
export const min = (a, b) => (lt(a, b) ? a : b);
export const max = (a, b) => (lt(a, b) ? b : a);
export const isZero = (a) => a.n === 0;
export const toFloat = (a) => a.n / a.d;
export const str = (a) => (a.d === 1 ? `${a.n}` : `${a.n}/${a.d}`);
/** Integer ticks (ticksPerQuarter) to a rational whole-note fraction. */
export const fromTicks = (t, ticksPerQuarter) => r(t, 4 * ticksPerQuarter);
/** Parse "3/16" or a number. */
export const parse = (s) => (typeof s === 'object' ? s : String(s).includes('/') ? r(...String(s).split('/').map(Number)) : r(Number(s)));

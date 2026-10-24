// "Time zoom": starts at the real clock and date, then speeds up through a few whole days
// to month-by-month seasons, and stays there. Everything is a function of tau, the real
// seconds since the start, so a still frame or a scrub can jump straight to any point.

// log10 of the time rate (simulated seconds per real second) at tau, for a ramp lasting
// `len` real seconds (44 by default). After the ramp the rate holds.
//   0 … 6/44   real time (x1)
//   … 14/44    up to 1 day every 8 s: the sun visibly moves, clouds race
//   … 30/44    up to 1 day every 3 s: a few whole days and nights go by
//   … 44/44    up to 1 month every 4 s, the day locked to one hour (a same-time-every-day
//              time-lapse) so only the seasons move
const KEYS = [[0, 0], [6, 0], [14, Math.log10(86400 / 8)], [30, Math.log10(86400 / 3)], [44, Math.log10(30 * 86400 / 4)]];
const sm = (x) => x * x * (3 - 2 * x);
export function logRate(tau, len = 44) {
  const t = (tau * 44) / len;
  if (t >= KEYS[KEYS.length - 1][0]) return KEYS[KEYS.length - 1][1];
  for (let i = 1; i < KEYS.length; i++) {
    const [t1, r1] = KEYS[i], [t0, r0] = KEYS[i - 1];
    if (t < t1) return r0 + (r1 - r0) * sm((t - t0) / (t1 - t0));
  }
  return 0;
}
export const rate = (tau, len) => Math.pow(10, logRate(tau, len));
// simulated seconds elapsed by tau (trapezoid rule, for scrubbing and still frames)
export function simSecondsAt(tau, len = 44) {
  const n = Math.max(1, Math.ceil(tau * 60));
  let s = 0, prev = rate(0, len);
  for (let i = 1; i <= n; i++) { const r = rate((tau * i) / n, len); s += ((prev + r) / 2) * (tau / n); prev = r; }
  return s;
}

// 0 = the clock runs freely … 1 = every day is shown at the lock hour only
export function dayLock(tau, len) { const x = Math.min(1, Math.max(0, (logRate(tau, len) - 4.6) / 0.9)); return sm(x); }

// Time-lapse strobe: as the lock tightens the day lingers near the lock hour and rushes
// through the rest, so each night shrinks to a blink before it vanishes. Continuous in h.
export function warpHour(h, lockHour, k) {
  if (k >= 0.98) return lockHour;
  const u = (((h - lockHour) / 24) % 1 + 1) % 1, v = 2 * u - 1, p = 1 + 60 * k * k;
  const w = Math.sign(v) * (1 - Math.pow(1 - Math.abs(v), p));
  return lockHour + 24 * (w + 1) / 2;
}

// Hour of the day to the time-of-day slider (0 noon … 4 night). There is no dawn
// keyframe, so the morning mirrors the evening: magic hour before sunrise, golden after.
const D = [0, 3, 5.3, 6.2, 7.2, 8], T = [0, 1, 2, 3, 3.5, 4];
export function hourToTime(h) {
  const d = Math.abs((((h % 24) + 24) % 24) - 12);
  for (let i = 1; i < D.length; i++) if (d < D[i]) return T[i - 1] + (T[i] - T[i - 1]) * (d - D[i - 1]) / (D[i] - D[i - 1]);
  return 4;
}

// Day of the year (fractional) to the seasons' s, northern hemisphere: s = 0 is early
// February (deep winter), so blossom (s 0.15) lands about 1 April, summer (0.42) in early
// July, late autumn (0.73) at the end of October and first snow (0.86) mid December.
const S0_DAY = 36;
export function seasonOfDate(date) {
  const y0 = new Date(date.getFullYear(), 0, 1);
  const doy = (date - y0) / 86400000;
  return ((((doy - S0_DAY) / 365) % 1) + 1) % 1;
}
export function dateOfSeason(s, year, hour) {
  const d = new Date(year, 0, 1); d.setTime(d.getTime() + (s * 365 + S0_DAY) * 86400000);
  d.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0); return d;
}

export function formatSpeed(r) {
  const perDay = 86400 / r;
  if (perDay > 30) return r < 1.5 ? 'real time' : `×${Math.round(r).toLocaleString('en-US')}`;
  if (perDay > 2) return `1 day every ${perDay.toFixed(perDay < 10 ? 1 : 0)} s`;
  const perMonth = (30 * 86400) / r;
  return `1 month every ${perMonth.toFixed(1)} s`;
}

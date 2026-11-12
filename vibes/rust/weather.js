// weather.js - Rust: a year of weather, hour by hour: showers that come and go, dew on clear nights, the
// seasons' warmth (corrosion about doubles for every 10 C and stops in frost) and, at the coast, salt.
// advance(hours) sums what the frame saw: the fraction of it under rain or dew, the mean warmth factor.
const rngOf = (seed) => { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

export const CLIMATES = {
  temperate: { name: 'Temperate', rain: 0.11, shower: 7, dew: 0.4, salt: 0, T: 11, Tamp: 7, sun: 0.45 },
  coastal: { name: 'Coastal', rain: 0.13, shower: 5, dew: 0.55, salt: 1, T: 12, Tamp: 5, sun: 0.5 },
  tropical: { name: 'Tropical', rain: 0.16, shower: 2.5, dew: 0.75, salt: 0.25, T: 27, Tamp: 2, sun: 0.65 },
  dry: { name: 'Desert', rain: 0.015, shower: 3, dew: 0.08, salt: 0, T: 21, Tamp: 9, sun: 0.95 },
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function makeWeather(climate, seed = 1) {
  const r = rngOf(seed * 101 + 9);
  const st = { hours: 0, raining: false, left: 0, power: 1, dewNight: false };
  let C = CLIMATES[climate] || CLIMATES.temperate;
  const startMonth = 2; // the piece goes up in March
  const hour = () => {
    const day = st.hours / 24, hod = st.hours % 24;
    const season = Math.cos(((day / 365.25 + (startMonth - 6.5) / 12) * 2 * Math.PI)); // 1 in midsummer
    const T = C.T + C.Tamp * season + 4 * Math.sin(((hod - 9) / 24) * 2 * Math.PI);
    // rain: starts at a rate that keeps it on the climate's share of the hours, lasts about `shower` hours
    if (st.left <= 0) {
      if (st.raining) { st.raining = false; st.left = -Math.log(1 - r()) * C.shower * (1 - C.rain) / C.rain; }
      else { st.raining = true; st.left = -Math.log(1 - r()) * C.shower; st.power = 0.25 + r() * r() * 2; }
    }
    st.left -= 1;
    if (hod === 18) st.dewNight = r() < C.dew;
    const dew = !st.raining && st.dewNight && (hod >= 23 || hod < 8);
    const warm = T < 0 ? 0.05 : Math.pow(2, (T - 15) / 10);
    st.hours += 1;
    return { rain: st.raining ? 1 : 0, power: st.power, dew: dew ? 1 : 0, warm, T };
  };
  let carry = 0; // fractional hours
  return {
    get climate() { return C; },
    set climate(id) { C = CLIMATES[id] || C; },
    state: st,
    // the weather over the next `h` hours (h may be a fraction of an hour)
    advance(h) {
      carry += h; let n = 0, rain = 0, dew = 0, warm = 0, power = 0;
      while (carry >= 1) { const w = hour(); n++; rain += w.rain; dew += w.dew; warm += w.warm; power += w.rain * w.power; carry -= 1; }
      if (n === 0) return { rainFrac: st.raining ? 1 : 0, dewFrac: 0, warm: 1, power: st.raining ? st.power : 0, raining: st.raining, salt: C.salt, hours: h };
      return { rainFrac: rain / n, dewFrac: dew / n, warm: warm / n, power: rain ? power / rain : 0, raining: st.raining, salt: C.salt, hours: h };
    },
    date() {
      const d = st.hours / 24, y = Math.floor(d / 365.25), mo = Math.floor(((d % 365.25) / 365.25) * 12);
      return { years: d / 365.25, label: `${y ? `${y} yr ` : ''}${Math.floor((d % 365.25) / 30.44)} mo`, month: MONTHS[(mo + startMonth) % 12], day: Math.floor(d) };
    },
    reset() { st.hours = 0; st.raining = false; st.left = 0; carry = 0; },
  };
}

// A year on the hill, as one function of s (0 … 1, looping). s = 0 is deep winter, so a
// loop opens with the snow melting: blossom, leaf-out, summer, the autumn turn, shedding,
// first snow. sampleSeason(s) returns everything the scene needs for that day.
import * as THREE from 'three';

const ss = THREE.MathUtils.smoothstep;
const C = (hex) => new THREE.Color(hex);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
// rise over a..b, fall over c..d
const bump = (s, a, b, c, d) => ss(s, a, b) * (1 - ss(s, c, d));

// leaf colours by stage slot: the six autumn stops, and green stand-ins for them in summer
const AUTUMN = [[0.22, 0.46, 0.14], [0.55, 0.74, 0.2], [0.98, 0.8, 0.18], [0.98, 0.52, 0.1], [0.88, 0.2, 0.07], [0.5, 0.24, 0.1]].map((c) => new THREE.Color(...c));
const SPRING = [[0.58, 0.82, 0.26], [0.64, 0.86, 0.3], [0.55, 0.8, 0.24], [0.62, 0.84, 0.28], [0.56, 0.8, 0.26], [0.6, 0.83, 0.3]].map((c) => new THREE.Color(...c));
const SUMMER = [[0.42, 0.68, 0.18], [0.36, 0.62, 0.2], [0.44, 0.7, 0.2], [0.38, 0.64, 0.18], [0.42, 0.68, 0.18], [0.4, 0.66, 0.2]].map((c) => new THREE.Color(...c));
// shadow side = tint * darkMul: summer's is the summer style's own ratio (blue-green)
const DARK_SUMMER = V(0.143, 0.294, 0.667), DARK_AUTUMN = V(0.55, 0.42, 0.34);
const RIM_SPRING = C('#fff0f6'), RIM_SUMMER = new THREE.Color(0.9, 1.0, 0.45), RIM_AUTUMN = new THREE.Color(1.0, 0.85, 0.4);

// ground: [grass base, tip, tip2, terrain dark, terrain light]
const GROUND = {
  spring: ['#24552c', '#5fae42', '#b4d85a', '#2a5a2e', '#5a9c3a'],
  summer: ['#1f4a2a', '#4e9a3c', '#98c54e', '#24502b', '#4f8f34'],
  autumn: ['#3a4826', '#8c9440', '#d2b65c', '#46502a', '#8a8a3c'],
  winter: ['#4a4a3a', '#9a9070', '#c8bc90', '#5a5a48', '#8a8468'],
};
for (const k in GROUND) GROUND[k] = GROUND[k].map(C);

export const SEASON_MARKS = { 'late winter': 0, blossom: 0.13, 'early summer': 0.3, summer: 0.42, 'autumn turning': 0.62, 'late autumn': 0.73, 'first snow': 0.86, winter: 0.95 };

function lerpList(a, b, t, out) { return a.map((c, i) => (out[i] || (out[i] = new THREE.Color())).copy(c).lerp(b[i], t)); }
const _pal = [], _g1 = [], _g2 = [];

export function sampleSeason(s) {
  s = ((s % 1) + 1) % 1;
  const o = {};
  // snow: lying, and falling
  o.snowCover = Math.min(1, 1 - ss(s, 0.03, 0.1) + ss(s, 0.84, 0.9));
  o.snowFall = Math.min(1, 1 - ss(s, 0.015, 0.05) + ss(s, 0.82, 0.86));
  // canopy: bare until the blossom opens, full through summer, shed in late autumn
  o.bare = Math.min(1, 1 - ss(s, 0.08, 0.15) + ss(s, 0.7, 0.83));
  o.bloom = 1 - ss(s, 0.17, 0.24);
  // colours: spring green deepening to summer, then the autumn palette with `turned`
  const greenK = ss(s, 0.2, 0.34), autumnK = ss(s, 0.48, 0.58);
  o.turned = THREE.MathUtils.clamp((s - 0.52) / 0.22, 0, 1);
  lerpList(SPRING, SUMMER, greenK, _g1);
  o.pal = lerpList(_g1, AUTUMN, autumnK, _pal);
  o.darkMul = DARK_SUMMER.clone().lerp(DARK_AUTUMN, autumnK);
  o.ambDesat = 0.65 * autumnK;
  o.rim = (s < 0.3 ? RIM_SPRING.clone().lerp(RIM_SUMMER, ss(s, 0.18, 0.28)) : RIM_SUMMER.clone().lerp(RIM_AUTUMN, autumnK));
  // falling: blossom petals, a few green leaves in summer, the autumn drop
  o.petalFall = s < 0.27;
  o.fall = Math.min(1, 0.9 * bump(s, 0.12, 0.17, 0.21, 0.26) + 0.12 * bump(s, 0.28, 0.32, 0.5, 0.56) + bump(s, 0.56, 0.66, 0.78, 0.85));
  // ground
  const G = GROUND;
  const k1 = ss(s, 0.06, 0.16), k2 = ss(s, 0.25, 0.38), k3 = ss(s, 0.55, 0.72), k4 = ss(s, 0.8, 0.88);
  lerpList(G.winter, G.spring, k1, _g2);
  lerpList(_g2, G.summer, k2, _g2); lerpList(_g2, G.autumn, k3, _g2); lerpList(_g2, G.winter, k4, _g2);
  o.ground = _g2;
  o.flowers = bump(s, 0.12, 0.22, 0.52, 0.64);
  // weather: greyer, more overcast winters
  const winter = Math.max(o.snowCover, o.snowFall * 0.8);
  o.clouds = 0.28 * winter;
  o.sat = 1 - 0.1 * winter;
  // sound: birds go quiet under snow, insects only in the warm months
  o.birds = 1 - 0.85 * winter;
  o.insects = bump(s, 0.26, 0.34, 0.66, 0.76);
  // how likely a rainy spell is: April showers, the tsuyu rainy season through June into
  // early July (s ≈ 0.3 … 0.42), a dry high summer, then the autumn rains of September
  o.wet = 0.18 + 0.1 * bump(s, 0.12, 0.16, 0.2, 0.24) + 0.42 * bump(s, 0.29, 0.32, 0.4, 0.44) + 0.2 * bump(s, 0.55, 0.59, 0.66, 0.7);
  return o;
}

// Rainy spells: a smooth random signal over days (a spell lasts a day or three, with dry
// runs between) thresholded by the season's wetness. Deterministic in the day number, so
// scrubbing back and forth replays the same weather. 0 dry … 1 raining hard.
function hash1(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
function noise1(x) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash1(i) * (1 - u) + hash1(i + 1) * u; }
export function rainOnDay(day, wet) {
  const n = noise1(day / 1.7) * 0.7 + noise1(day / 0.6 + 40) * 0.3;
  const k = 0.68 - 0.42 * wet; // noise sits mostly near 0.5: map wetness to a threshold so wet ≈ share of rainy days
  // snow takes over in the winter, see main.js
  return ss(n, k, k + 0.12);
}

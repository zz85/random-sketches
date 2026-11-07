// astro.js - the ephemeris, on Astronomy Engine (MIT, Don Cross).
// World frame (three.js): +x east, +y up (zenith), -z north. The observer's eye is the origin.
import * as THREE from 'three/webgpu';

const A = window.Astronomy;
export const AU_KM = 149597870.7;

// mean radii in km, and how each is drawn when "magnified": planets come 1000x closer;
// the Sun and Moon would swallow the sky at that, so they only grow a few times
// the most a brought-closer body is drawn across, in degrees: the Sun and Moon, and the planets
export const MAX_DEG = { lights: 14, planets: 36 };
export const BODIES = [
  { key: 'Sun', name: 'Sun', km: 695700, near: 12, color: '#ffd27a' },
  { key: 'Moon', name: 'Moon', km: 1737.4, near: 17, color: '#e6e4dc' },
  { key: 'Mercury', name: 'Mercury', km: 2439.7, near: 2000, color: '#b7aea4' },
  { key: 'Venus', name: 'Venus', km: 6051.8, near: 2000, color: '#f3e3b4' },
  { key: 'Mars', name: 'Mars', km: 3389.5, near: 2000, color: '#e0784a' },
  { key: 'Jupiter', name: 'Jupiter', km: 69911, near: 2000, color: '#e7c9a0' },
  { key: 'Saturn', name: 'Saturn', km: 58232, near: 2000, color: '#ecd59a' },
  { key: 'Uranus', name: 'Uranus', km: 25362, near: 2000, color: '#a6e2ea' },
  { key: 'Neptune', name: 'Neptune', km: 24622, near: 2000, color: '#6f8fef' },
];

export const eqjVec = (raDeg, decDeg, out = new THREE.Vector3()) => {
  const ra = raDeg * Math.PI / 180, de = decDeg * Math.PI / 180;
  return out.set(Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de));
};

const tmp = new THREE.Vector3();

export class Sky {
  constructor() {
    this.M = new THREE.Matrix4(); // EQJ (J2000 equatorial) -> world
    this.bodies = {};
    for (const b of BODIES) this.bodies[b.key] = { ...b, dir: new THREE.Vector3(), eqj: new THREE.Vector3(), sun: new THREE.Vector3(1, 0, 0), north: new THREE.Vector3(0, 1, 0), pm: new THREE.Vector3(1, 0, 0), alt: 0, az: 0, dist: 1, diam: 0, ra: 0, dec: 0, frac: 1 };
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.pole = new THREE.Vector3(); this.lst = 0;
  }

  update(date, lat, lon, height = 0) {
    const t = A.MakeTime(date), o = new A.Observer(lat, lon, height);
    this.time = t; this.observer = o; this.date = date; this.lat = lat; this.lon = lon;
    const r = A.Rotation_EQJ_HOR(t, o).rot;
    // Astronomy Engine's HOR frame is x north, y west, z zenith; world is (east, up, -north) = (-y, z, -x)
    const e = (i, j) => r[j][i];
    this.M.set(
      -e(1, 0), -e(1, 1), -e(1, 2), 0,
      e(2, 0), e(2, 1), e(2, 2), 0,
      -e(0, 0), -e(0, 1), -e(0, 2), 0,
      0, 0, 0, 1);
    this.pole.set(0, 0, 1).applyMatrix4(this.M);
    this.lst = ((A.SiderealTime(t) + lon / 15) % 24 + 24) % 24;
    const sunEq = A.Equator('Sun', t, o, false, true).vec;
    for (const b of BODIES) {
      const s = this.bodies[b.key];
      const eq = A.Equator(b.key, t, o, false, true); // J2000, topocentric, aberration-corrected
      s.dist = eq.dist; s.ra = eq.ra; s.dec = eq.dec;
      s.eqj.set(eq.vec.x, eq.vec.y, eq.vec.z).normalize();
      s.dir.copy(s.eqj).applyMatrix4(this.M).normalize();
      s.alt = Math.asin(THREE.MathUtils.clamp(s.dir.y, -1, 1)) * 180 / Math.PI;
      s.az = (Math.atan2(s.dir.x, -s.dir.z) * 180 / Math.PI + 360) % 360;
      s.diam = 2 * Math.asin(Math.min(1, b.km / (eq.dist * AU_KM))) * 180 / Math.PI; // degrees
      // direction from the body to the Sun, in world space: lights its phase
      if (b.key === 'Sun') s.sun.copy(s.dir).negate();
      else s.sun.set(sunEq.x - eq.vec.x, sunEq.y - eq.vec.y, sunEq.z - eq.vec.z).normalize().applyMatrix4(this.M).normalize();
      s.frac = 0.5 * (1 - s.sun.dot(s.dir));
      // its north pole and prime meridian (IAU), so textures turn the way the real surfaces do
      const ax = A.RotationAxis(b.key, t);
      s.north.set(ax.north.x, ax.north.y, ax.north.z);
      const node = tmp.set(0, 0, 1).cross(s.north).normalize(); // ascending node of the body's equator
      const q = new THREE.Vector3().crossVectors(s.north, node);
      const W = (ax.spin % 360) * Math.PI / 180;
      s.pm.copy(node).multiplyScalar(Math.cos(W)).addScaledVector(q, Math.sin(W));
      s.north.applyMatrix4(this.M).normalize(); s.pm.applyMatrix4(this.M).normalize();
    }
    this.sunDir.copy(this.bodies.Sun.dir);
    return this;
  }

  details(key) {
    const t = this.time, o = this.observer, s = this.bodies[key];
    const out = { name: s.name, alt: s.alt, az: s.az, dist: s.dist, ra: s.ra, dec: s.dec, diam: s.diam, frac: key === 'Sun' ? null : s.frac };
    try {
      out.mag = key === 'Sun' ? -26.7 : A.Illumination(key, t).mag;
      const rise = A.SearchRiseSet(key, o, +1, t, 1.2), set = A.SearchRiseSet(key, o, -1, t, 1.2);
      out.rise = rise && rise.date; out.set = set && set.date;
      const tr = A.SearchHourAngle(key, o, 0, t); out.transit = tr && tr.time.date; out.transitAlt = tr && tr.hor.altitude;
      out.constellation = A.Constellation(s.ra, s.dec).name;
      if (key === 'Moon') out.phaseDeg = A.MoonPhase(t);
    } catch (e) { /* polar day or night: no rise or set */ }
    return out;
  }
}

export function moonPhaseName(deg) {
  const n = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
  return n[Math.round(deg / 45) % 8];
}

// magnetic declination (WMM via geomag.js), degrees east, for turning a compass heading into true north
export function declination(lat, lon) {
  try { return window.geomag.field(lat, lon, 0).declination || 0; } catch (e) { return 0; }
}

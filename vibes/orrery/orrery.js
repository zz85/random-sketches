// orrery.js - the back of the watch: a little orrery under a display caseback, Earth-centred or Sun-centred.
// The dial is the ecliptic seen from its north side, Aries at twelve o'clock. Earth-centred, Earth turns on the
// centre arbor with your place pinned on it and the Moon, Sun and planets ride gold arms at their true geocentric
// longitudes and latitudes (the arms' lengths are only an order, Ptolemy's), so seen from Earth's centre every
// globe is in its true direction. Sun-centred, the arms swing to heliocentric longitudes and the Moon rides round
// Earth. Each globe is lit from the real Sun's direction,
// so the Moon's phase and the night side of Earth are the real ones.
import * as THREE from 'three/webgpu';
import { uniform, uv, vec3, float, mix, smoothstep, normalize, dot, pow, texture, normalWorld, positionWorld, cameraPosition } from 'three/tsl';
import { BODIES, MAX_DEG } from './astro.js';
import { globeMaterial, ringMaterial, RING_IN, RING_OUT, tex, MAPS, THREE_TEX } from './planets.js';
import { labelSprite } from './materials.js';

const A = window.Astronomy;
const EPS = 23.4393 * Math.PI / 180, cE = Math.cos(EPS), sE = Math.sin(EPS);
const RD = 0.86; // the dial's radius, as the chart's
export const ORBIT = { Moon: 0.16, Mercury: 0.235, Venus: 0.3, Sun: 0.375, Mars: 0.45, Jupiter: 0.525, Saturn: 0.595, Uranus: 0.655, Neptune: 0.71 };
// Sun-centred, the planets in their true order out from the Sun, the Moon on a short arm round Earth
export const HELIO = { Moon: 0.055, Mercury: 0.13, Venus: 0.205, Earth: 0.29, Mars: 0.37, Jupiter: 0.47, Saturn: 0.56, Uranus: 0.64, Neptune: 0.71 };
const SIZE = { Sun: 0.055, Moon: 0.029, Mercury: 0.019, Venus: 0.025, Mars: 0.0225, Jupiter: 0.045, Saturn: 0.035, Uranus: 0.024, Neptune: 0.0225 };
export const EARTH_R = 0.08, PLANE_Z = 0.06; // Earth's centre and every arm's body sit in one plane, so directions are true
const GOLD = new THREE.Color(0xe7c47c);
const SIGNS = ['ARIES', 'TAURUS', 'GEMINI', 'CANCER', 'LEO', 'VIRGO', 'LIBRA', 'SCORPIO', 'SAGITTARIUS', 'CAPRICORN', 'AQUARIUS', 'PISCES'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// J2000 equatorial -> ecliptic, in place
export const toEcl = (v) => v.set(v.x, v.y * cE + v.z * sE, -v.y * sE + v.z * cE);

function canvas(n) { const c = document.createElement('canvas'); c.width = c.height = n; return c; }
function canvasTex(c, srgb) { const t = new THREE.CanvasTexture(c); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; return t; }

// text along a circle, centred on dial angle `ang` (counter-clockwise from +x), reading clockwise
function arcText(g, text, r, ang, track = 0) {
  const ch = [...text], w = ch.map((c) => g.measureText(c).width + track), tot = w.reduce((a, b) => a + b, 0) - track;
  let a = -ang - tot / 2 / r;
  ch.forEach((c, i) => {
    a += (w[i] - track) / 2 / r;
    g.save(); g.translate(Math.cos(a) * r, Math.sin(a) * r); g.rotate(a + Math.PI / 2); g.fillText(c, 0, 0); g.restore();
    a += ((w[i] - track) / 2 + track) / r;
  });
}

// the dial: lapis enamel, and a gold-ink mask of orbits, the zodiac and the Sun's calendar
function drawDial(year) {
  const N = 2048, K = N / 2 / RD, px = (r) => r * K;
  const en = canvas(N), e = en.getContext('2d');
  e.translate(N / 2, N / 2);
  const gr = e.createRadialGradient(0, 0, 0, 0, 0, N / 2);
  gr.addColorStop(0, '#13296e'); gr.addColorStop(0.6, '#0b1b52'); gr.addColorStop(1, '#060f33');
  e.fillStyle = gr; e.fillRect(-N / 2, -N / 2, N, N);
  // guilloche: a sunburst of fine rays, and rings
  e.globalAlpha = 0.06; e.strokeStyle = '#9fb4ff'; e.lineWidth = 1.2;
  for (let i = 0; i < 480; i++) { const a = i / 480 * Math.PI * 2; e.beginPath(); e.moveTo(Math.cos(a) * 60, Math.sin(a) * 60); e.lineTo(Math.cos(a) * px(0.74), Math.sin(a) * px(0.74)); e.stroke(); }
  e.globalAlpha = 0.05; for (let r = 40; r < px(0.74); r += 7) { e.beginPath(); e.arc(0, 0, r, 0, Math.PI * 2); e.stroke(); }
  // aventurine
  e.globalAlpha = 1;
  for (let i = 0; i < 2600; i++) { const r = Math.sqrt(Math.random()) * N / 2, a = Math.random() * Math.PI * 2; e.fillStyle = `rgba(220,230,255,${0.08 + Math.random() * 0.3})`; e.fillRect(Math.cos(a) * r, Math.sin(a) * r, 1.6, 1.6); }

  const gd = canvas(N), g = gd.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, N, N); g.translate(N / 2, N / 2);
  g.strokeStyle = g.fillStyle = '#fff';
  const ring = (r, w) => { g.lineWidth = w; g.beginPath(); g.arc(0, 0, px(r), 0, Math.PI * 2); g.stroke(); };
  // zodiac band
  const z0 = 0.79, z1 = 0.855;
  ring(z0, 3); ring(z1, 3); ring(0.752, 2);
  for (let d = 0; d < 360; d++) {
    const a = -(Math.PI / 2 + d * Math.PI / 180), l = d % 30 === 0 ? z1 - z0 : d % 10 === 0 ? 0.016 : d % 5 === 0 ? 0.011 : 0.006;
    g.lineWidth = d % 30 === 0 ? 3 : 1.3;
    g.beginPath(); g.moveTo(Math.cos(a) * px(z0), Math.sin(a) * px(z0)); g.lineTo(Math.cos(a) * px(z0 + l), Math.sin(a) * px(z0 + l)); g.stroke();
  }
  g.font = '600 31px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  SIGNS.forEach((s, i) => arcText(g, s, px(0.832), Math.PI / 2 + (i * 30 + 15) * Math.PI / 180, 6));
  // the Sun's calendar: where its arm points on the first of each month, and each day
  g.font = 'italic 24px Georgia, serif';
  const lam = (d) => A.SunPosition(A.MakeTime(d)).elon * Math.PI / 180;
  for (let m = 0; m < 12; m++) {
    const days = new Date(year, m + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const a = -(Math.PI / 2 + lam(new Date(year, m, d, 12))), l = d === 1 ? 0.038 : d % 5 === 0 ? 0.012 : 0.006;
      g.lineWidth = d === 1 ? 2.4 : 1;
      g.beginPath(); g.moveTo(Math.cos(a) * px(0.79), Math.sin(a) * px(0.79)); g.lineTo(Math.cos(a) * px(0.79 - l), Math.sin(a) * px(0.79 - l)); g.stroke();
    }
    arcText(g, MONTHS[m], px(0.769), Math.PI / 2 + lam(new Date(year, m, 16)), 3);
  }
  return { enamel: canvasTex(en, true), gold: canvasTex(gd, false) };
}

function earthMaterial(uL) {
  const m = new THREE.MeshBasicNodeMaterial();
  const n = normalize(normalWorld), v = normalize(cameraPosition.sub(positionWorld)), mu0 = dot(n, uL);
  const day = texture(tex(THREE_TEX + 'earth_atmos_2048.jpg'), uv()).rgb;
  const night = texture(tex(THREE_TEX + 'earth_lights_2048.png'), uv()).rgb;
  const lit = smoothstep(-0.1, 0.25, mu0);
  const rim = pow(dot(n, v).max(0).oneMinus(), 3).mul(smoothstep(-0.3, 0.4, mu0));
  m.colorNode = day.mul(mu0.max(0).mul(0.95).add(0.05)).mul(1.35).mul(lit.mul(0.9).add(0.1))
    .add(night.mul(vec3(1.0, 0.8, 0.5)).mul(lit.oneMinus()).mul(1.6))
    .add(vec3(0.3, 0.55, 1.0).mul(rim).mul(0.9));
  return m;
}

export function buildOrrery() {
  const group = new THREE.Group(); // in the watch's frame: +z out of the dial
  const sys = new THREE.Group(); sys.rotation.z = Math.PI / 2; group.add(sys); // ecliptic frame: +x the equinox, at twelve o'clock
  const O = { group, sys, bodies: {}, year: null, arms: {}, works: [], fadeMats: [] };
  const fadeMat = (m) => { m.transparent = true; O.fadeMats.push(m); return m; };
  // the works, which fade as you dive into the machine and leave only the globes on the sky
  const gold = fadeMat(new THREE.MeshPhysicalNodeMaterial({ color: GOLD, metalness: 1, roughness: 0.22 }));
  const goldPol = fadeMat(new THREE.MeshPhysicalNodeMaterial({ color: GOLD, metalness: 1, roughness: 0.1 }));
  const goldSel = new THREE.MeshPhysicalNodeMaterial({ color: GOLD, metalness: 1, roughness: 0.1 });

  const dial = new THREE.Mesh(new THREE.CircleGeometry(RD, 256), fadeMat(new THREE.MeshPhysicalNodeMaterial({ clearcoat: 0.9, clearcoatRoughness: 0.08 })));
  dial.receiveShadow = true; group.add(dial); O.dial = dial;
  const flG = new THREE.CylinderGeometry(0.95, RD - 0.004, 0.07, 256, 1, true); flG.rotateX(Math.PI / 2);
  const fl = new THREE.Mesh(flG, fadeMat(new THREE.MeshPhysicalNodeMaterial({ color: new THREE.Color(0x0a1640), metalness: 0.2, roughness: 0.35, side: THREE.DoubleSide })));
  fl.position.z = 0.07; group.add(fl);
  // the centre arbor carries whatever is at the centre: Earth, or the Sun
  const arbor = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.016, PLANE_Z, 32), goldPol);
  arbor.rotation.x = Math.PI / 2; arbor.position.z = PLANE_Z / 2; arbor.castShadow = true; sys.add(arbor);
  const collet = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.005, 12, 48), goldPol); collet.position.z = 0.004; sys.add(collet);
  O.works.push(dial, fl, arbor, collet);

  const uLE = uniform(new THREE.Vector3(1, 0, 0));
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), earthMaterial(uLE));
  earth.matrixAutoUpdate = false; earth.castShadow = true; sys.add(earth);
  // you are here: a gold pin with a red cabochon, in Earth's unit frame
  const pin = new THREE.Group(), pinIn = new THREE.Group(); pin.add(pinIn);
  const needle = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.32, 12), goldSel); needle.rotation.x = Math.PI; needle.position.y = 0.16;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 12), new THREE.MeshPhysicalNodeMaterial({ color: 0xc8102e, roughness: 0.1, clearcoat: 1 }));
  head.position.y = 0.34; pinIn.add(needle, head); earth.add(pin);
  const eLabel = labelSprite('Earth', { size: 40, color: '#f3dda7', italic: true, spacing: 0.04, depthTest: false });
  eLabel.material.sizeAttenuation = true; eLabel.renderOrder = 8; group.add(eLabel);
  O.earth = { mesh: earth, uL: uLE, pin, pinIn, label: eLabel, r: EARTH_R, pos: new THREE.Vector3() };

  // an arm for each body, from its anchor (the centre, or Earth for the Moon when the Sun is at the centre),
  // with an engraved orbit ring round the same anchor; the inner arms ride highest, as on a real orrery
  const ringMat = fadeMat(new THREE.MeshPhysicalNodeMaterial({ color: GOLD, metalness: 1, roughness: 0.3 }));
  const armG = new THREE.BoxGeometry(1, 0.0065, 0.0016); armG.translate(0.5, 0, 0);
  const postG = new THREE.CylinderGeometry(0.0022, 0.0022, 1, 10); postG.rotateX(Math.PI / 2); postG.translate(0, 0, 0.5);
  const order = ['Moon', 'Mercury', 'Venus', 'Earth', 'Sun', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  for (const key of order) {
    const i = order.indexOf(key), armZ = 0.036 - i * 0.0031, r0 = Math.max(ORBIT[key] || 0, HELIO[key] || 0);
    const pivot = new THREE.Group(); sys.add(pivot);
    const arm = new THREE.Mesh(armG, gold); arm.position.set(-0.015, 0, armZ); arm.castShadow = true;
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.003, 20), gold); boss.rotation.x = Math.PI / 2; boss.position.set(-0.03, 0, armZ);
    const post = new THREE.Mesh(postG, goldPol); post.castShadow = true;
    pivot.add(arm, boss, post);
    const w = 0.0024 / r0, ring = new THREE.Mesh(new THREE.RingGeometry(1 - w, 1, 256), ringMat); ring.position.z = 0.0012; sys.add(ring);
    O.arms[key] = { pivot, arm, boss, post, ring, armZ };
    O.works.push(pivot, ring);
  }
  for (const b of BODIES) {
    const key = b.key, sz = SIZE[key];
    const node = new THREE.Group(); sys.add(node);
    const uL = uniform(new THREE.Vector3(1, 0, 0));
    let globe;
    if (key === 'Sun') {
      const m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = texture(tex(MAPS.Sun), uv()).rgb.mul(vec3(2.4, 1.7, 0.9));
      globe = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), m);
    } else {
      globe = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 40), globeMaterial(key, uL, { air: false }));
      if (key === 'Saturn') { const ring = new THREE.Mesh(new THREE.RingGeometry(RING_IN, RING_OUT, 128, 1), ringMaterial(uL)); ring.rotation.x = -Math.PI / 2; ring.renderOrder = 2; globe.add(ring); }
    }
    globe.castShadow = true; globe.userData.key = key; node.add(globe); node.scale.setScalar(sz);
    const sel = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.07, 8, 64), goldSel); sel.visible = false; node.add(sel);
    const label = labelSprite(b.name, { size: 40, color: '#f3dda7', italic: true, spacing: 0.04, depthTest: false });
    label.material.sizeAttenuation = true; label.renderOrder = 8; group.add(label);
    O.bodies[key] = { mesh: globe, node, uL, label, sel, size: sz };
  }
  O.setYear = (year) => {
    if (O.year === year) return; O.year = year;
    const d = drawDial(year);
    if (O._tex) O._tex.forEach((t) => t.dispose()); O._tex = [d.enamel, d.gold];
    const mask = texture(d.gold, uv()).r;
    const m = dial.material;
    m.colorNode = mix(texture(d.enamel, uv()).rgb, vec3(GOLD.r, GOLD.g, GOLD.b), mask);
    m.metalnessNode = mask; m.roughnessNode = mix(float(0.4), float(0.26), mask); m.needsUpdate = true;
  };
  return O;
}

const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vU = new THREE.Vector3(), mB = new THREE.Matrix4(), mInv = new THREE.Matrix4(), wB = new THREE.Vector3();
// a world (horizon) vector of the sky into the dial's ecliptic frame
const toDial = (v, out) => toEcl(out.copy(v).applyMatrix4(mInv));
const lerp = THREE.MathUtils.lerp, sst = THREE.MathUtils.smoothstep;
const lerpAng = (a, b, t) => a + (((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * t;
// where each body is, as an arm: anchor (x, y), angle, length, and height above the arm plane
const geo = {}, hel = {}, cur = {};
for (const k of ['Earth', ...BODIES.map((b) => b.key)]) { geo[k] = { ax: 0, ay: 0, a: 0, r: 0, z: 0 }; hel[k] = { ax: 0, ay: 0, a: 0, r: 0, z: 0 }; cur[k] = { ax: 0, ay: 0, a: 0, r: 0, z: 0 }; }
let helioAt = NaN;
const eclOf = (v, r, out) => { toEcl(vA.copy(v)); const n = vA.length() || 1; out.a = Math.atan2(vA.y, vA.x); out.r = r; out.z = Math.tan(Math.asin(THREE.MathUtils.clamp(vA.z / n, -1, 1))) * r; return out; };

// helio: 0 Earth at the centre, 1 the Sun. dive: 0 on the wrist, 1 standing on the pin. sink: how far Earth's
// centre drops below the orrery's centre along your zenith, so that your eye, standing on the pin, is at the centre
export function updateOrrery(O, sky, date, { labels = 1, selected = null, earthScale = 1, showLabels = true, dive = 0, magnify = 0, helio = 0, sink = 0, pinScale = 1 } = {}) {
  O.setYear(date.getFullYear());
  mInv.copy(sky.M).transpose();
  const op = 1 - sst(dive, 0.28, 0.55), gs = sst(dive, 0.35, 0.95);
  for (const m of O.fadeMats) { m.opacity = op; m.depthWrite = op > 0.98; }
  for (const w of O.works) w.visible = op > 0.001;
  // Earth-centred: each body at its true geocentric longitude and latitude
  for (const b of BODIES) eclOf(sky.bodies[b.key].eqj, ORBIT[b.key], geo[b.key]);
  geo.Earth.r = 0; geo.Earth.z = 0;
  // Sun-centred: heliocentric longitudes and latitudes, the Moon round Earth
  if (helio > 0.0005) {
    const t = sky.time.ut;
    if (t !== helioAt) {
      helioAt = t;
      for (const k of ['Earth', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) { const h = A.HelioVector(A.Body[k], sky.time); eclOf(vB.set(h.x, h.y, h.z), HELIO[k], hel[k]); }
    }
    const e = hel.Earth;
    Object.assign(hel.Sun, { ax: 0, ay: 0, a: geo.Sun.a, r: 0, z: 0 });
    Object.assign(hel.Moon, { ax: Math.cos(e.a) * e.r, ay: Math.sin(e.a) * e.r, a: geo.Moon.a, r: HELIO.Moon, z: geo.Moon.z / ORBIT.Moon * HELIO.Moon });
  }
  geo.Earth.a = hel.Earth.a; // so Earth doesn't spin its arm round as it leaves the centre
  const hs = sst(helio, 0, 1);
  for (const k in cur) {
    const g = geo[k], h = hel[k], c = cur[k];
    if (hs <= 0.0005) Object.assign(c, g);
    else { c.ax = lerp(g.ax, h.ax, hs); c.ay = lerp(g.ay, h.ay, hs); c.a = lerpAng(g.a, h.a, hs); c.r = lerp(g.r, h.r, hs); c.z = lerp(g.z, h.z, hs); }
    const A_ = O.arms[k];
    A_.pivot.position.set(c.ax, c.ay, 0); A_.pivot.rotation.z = c.a;
    const show = c.r > 0.01;
    A_.arm.visible = A_.boss.visible = A_.post.visible = show;
    A_.arm.scale.x = c.r + 0.015;
    A_.post.position.set(c.r, 0, A_.armZ); A_.post.scale.z = Math.max(0.001, PLANE_Z + c.z - A_.armZ);
    A_.ring.visible = show; A_.ring.position.x = c.ax; A_.ring.position.y = c.ay; A_.ring.scale.setScalar(Math.max(c.r, 0.001));
  }
  for (const b of BODIES) {
    const s = sky.bodies[b.key], o = O.bodies[b.key], c = cur[b.key];
    o.node.position.set(c.ax + Math.cos(c.a) * c.r, c.ay + Math.sin(c.a) * c.r, PLANE_Z + c.z);
    // the size it has on the wrist, and in the dive the size the sky view draws it, seen from the centre
    const ang = Math.min(s.diam * (1 + (b.near - 1) * magnify), b.key === 'Moon' || b.key === 'Sun' ? MAX_DEG.lights : MAX_DEG.planets) * Math.PI / 180;
    const sz = b.key === 'Sun' ? lerp(o.size, 0.085, hs) : o.size;
    o.curSize = lerp(sz, Math.hypot(c.r, c.z) * Math.tan(ang / 2), gs);
    o.node.scale.setScalar(o.curSize);
    if (b.key !== 'Sun') {
      toDial(s.north, vB); toDial(s.pm, vC); vC.addScaledVector(vB, -vC.dot(vB)).normalize();
      mB.makeBasis(vC, vB, vA.crossVectors(vC, vB)); o.node.quaternion.setFromRotationMatrix(mB);
    }
    o.sel.visible = selected === b.key;
    if (o.sel.visible) o.sel.quaternion.copy(o.node.quaternion).invert();
  }
  // Earth: its pole tilted toward ecliptic longitude 90, turned by Greenwich sidereal time
  const gst = (sky.lst * 15 - sky.lon) * Math.PI / 180, cg = Math.cos(gst), sg = Math.sin(gst);
  const bx = toEcl(vA.set(cg, sg, 0)), by = toEcl(vB.set(0, 0, 1)), bz = toEcl(vC.set(sg, -cg, 0));
  const E = O.earth, ce = cur.Earth, rs = lerp(EARTH_R, 0.04, hs) * earthScale;
  const la = sky.lat * Math.PI / 180, lo = sky.lon * Math.PI / 180;
  E.pin.position.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
  E.pin.quaternion.setFromUnitVectors(wB.set(0, 1, 0), E.pin.position);
  E.pinIn.scale.setScalar(Math.max(0.001, pinScale)); E.pin.visible = pinScale > 0.01;
  // your zenith, in the dial's frame
  vU.copy(bx).multiplyScalar(E.pin.position.x).addScaledVector(by, E.pin.position.y).addScaledVector(bz, E.pin.position.z);
  E.pos.set(ce.ax + Math.cos(ce.a) * ce.r, ce.ay + Math.sin(ce.a) * ce.r, PLANE_Z).addScaledVector(vU, -sink);
  E.r = rs;
  E.mesh.matrix.makeBasis(bx, by, bz).scale(wB.set(rs, rs, rs)).setPosition(E.pos);
  E.mesh.matrixWorldNeedsUpdate = true; E.mesh.visible = rs > 1e-6;
  O.group.updateMatrixWorld(true);
  // light every globe from the real Sun's direction (the little Sun's place on the dial would give the wrong
  // phases, since the arms' lengths are only an order), turned from the ecliptic frame into the watch's world
  mB.extractRotation(O.sys.matrixWorld);
  for (const b of BODIES) { if (b.key === 'Sun') continue; toDial(sky.bodies[b.key].sun, O.bodies[b.key].uL.value).applyMatrix4(mB).normalize(); }
  toEcl(E.uL.value.copy(sky.bodies.Sun.eqj)).applyMatrix4(mB).normalize();
  // names under the globes (the group isn't turned, the ecliptic frame inside it is)
  const lh = 0.03, put = (L, p, size) => { L.position.set(-p.y, p.x - size - 0.02, PLANE_Z + 0.03); L.scale.set(lh * L.userData.aspect, lh, 1); };
  for (const b of BODIES) { const o = O.bodies[b.key]; put(o.label, o.node.position, o.curSize); o.label.visible = showLabels && labels > 0; }
  put(E.label, E.pos, rs); E.label.visible = showLabels && labels > 0 && hs > 0.5;
}

// the pin in the watch's world, and Earth's centre, for the camera's dive
export function pinWorld(O, outPin, outCentre) {
  O.earth.mesh.getWorldPosition(outCentre);
  O.earth.pin.getWorldPosition(outPin);
  return outPin;
}

// a rotation that takes the sky's world (east, up, -north) into the watch's world, for the same directions
const mR = new THREE.Matrix4(), mE = new THREE.Matrix4().set(1, 0, 0, 0, 0, cE, sE, 0, 0, -sE, cE, 0, 0, 0, 0, 1), mS = new THREE.Matrix4();
export function skyToWatch(O, sky, outQuat) {
  mS.extractRotation(O.sys.matrixWorld);
  mR.copy(sky.M).transpose(); // world -> EQJ
  mR.premultiply(mE).premultiply(mS);
  return outQuat.setFromRotationMatrix(mR);
}

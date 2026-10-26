// Camera zoom steps like a phone's camera app (0.5×, 1×, 2×, 3×, 5×), built from what the browser
// exposes. Two mechanisms, and phones differ in which they offer:
//   - the track's own `zoom` (MediaStreamTrack capabilities: Chrome on Android, Safari 17+): a
//     continuous range; on some phones it reaches below 1 (the ultra-wide behind one logical camera)
//   - separate lenses as separate camera devices: Safari names them ("Back Ultra Wide Camera",
//     "Back Telephoto Camera"), Chrome on Android does not ("camera2 2, facing back"), so an unnamed
//     extra back camera is offered as "Lens N" for the user to try.
// A front camera is never offered: the court is filmed with the back one.
//
//   zoomOptions({ devices, current, caps }) -> [{ key, label, title, deviceId, zoom }]
//     devices: enumerateDevices() video inputs ({ deviceId, label }); current: the track's deviceId;
//     caps: the track's getCapabilities(). zoom is null for a lens chosen as it is.
export const STEPS = [0.5, 1, 2, 3, 5];

export function lensKind(label = '') {
  const l = label.toLowerCase();
  if (/front|facing front|user|selfie|facetime/.test(l)) return 'front';
  if (/ultra ?wide|ultrawide|0\.5/.test(l)) return 'ultra';
  if (/tele/.test(l)) return 'tele';
  // virtual multi-lens devices: one camera that zooms across its lenses
  if (/dual|triple/.test(l)) return 'multi';
  return 'back';
}

const fmt = (z) => `${+z.toFixed(1)}×`;

export function zoomOptions({ devices = [], current = null, caps = {} } = {}) {
  const back = devices.filter((d) => lensKind(d.label) !== 'front');
  const out = [], z = caps.zoom && Number.isFinite(caps.zoom.min) && Number.isFinite(caps.zoom.max) && caps.zoom.max > caps.zoom.min ? caps.zoom : null;
  const add = (o) => { if (!out.some((p) => p.key === o.key)) out.push(o); };
  // the current camera's own zoom: every step inside its range, and its widest end when that is
  // wider than 1× but not a step (0.6×, 0.7×)
  if (z) {
    const steps = STEPS.filter((s) => s >= z.min - 1e-6 && s <= z.max + 1e-6);
    if (z.min < 1 - 1e-6 && !steps.some((s) => Math.abs(s - z.min) < 0.05)) steps.unshift(+z.min.toFixed(2));
    for (const s of steps) add({ key: `${current}|${s}`, label: fmt(s), title: s < 1 ? 'wider: more of the court in view' : s > 1 ? 'closer' : 'the camera as it is', deviceId: current, zoom: s });
  }
  const has = (pred) => out.some(pred);
  // lenses the current camera's zoom does not already cover
  for (const d of back) {
    if (d.deviceId === current) continue;
    const k = lensKind(d.label);
    if (k === 'ultra' && !has((o) => o.zoom != null && o.zoom < 1)) add({ key: `${d.deviceId}|`, label: '0.5×', title: `${d.label || 'ultra-wide lens'}: more of the court in view`, deviceId: d.deviceId, zoom: null });
    else if (k === 'tele' && !has((o) => o.zoom != null && o.zoom >= 2)) add({ key: `${d.deviceId}|`, label: 'Tele', title: d.label || 'telephoto lens', deviceId: d.deviceId, zoom: null });
  }
  // the current camera as it is, when nothing above gave a 1×
  if (!has((o) => o.deviceId === current && (o.zoom == null || Math.abs(o.zoom - 1) < 1e-6))) {
    const cur = back.find((d) => d.deviceId === current);
    out.unshift({ key: `${current}|`, label: '1×', title: cur?.label || 'this camera', deviceId: current, zoom: null });
  }
  // other back cameras the browser does not name: let the user try them
  let n = 2;
  for (const d of back) {
    if (d.deviceId === current || out.some((o) => o.deviceId === d.deviceId) || ['ultra', 'tele'].includes(lensKind(d.label))) continue; // named lenses the zoom covers
    add({ key: `${d.deviceId}|`, label: lensKind(d.label) === 'multi' ? 'All lenses' : `Lens ${n++}`, title: `${d.label || 'another back camera'} (try it: it may be the wide or the tele lens)`, deviceId: d.deviceId, zoom: null });
  }
  // widest first, named lenses after the zoom steps they extend
  const order = (o) => (o.label === 'Tele' ? 50 : o.label.startsWith('Lens') || o.label === 'All lenses' ? 100 + out.indexOf(o) : o.zoom ?? (o.label === '0.5×' ? 0.5 : 1));
  return out.sort((a, b) => order(a) - order(b));
}

// The option matching what the camera is doing now (settings: the track's getSettings()).
export function currentOption(options, settings = {}) {
  const mine = options.filter((o) => o.deviceId === settings.deviceId);
  if (settings.zoom != null) { const z = mine.filter((o) => o.zoom != null).sort((a, b) => Math.abs(a.zoom - settings.zoom) - Math.abs(b.zoom - settings.zoom))[0]; if (z && Math.abs(z.zoom - settings.zoom) < 0.05) return z; }
  return mine.find((o) => o.zoom == null) ?? mine.find((o) => o.zoom === 1) ?? null;
}

import { test, expect } from 'bun:test';
import { zoomOptions, currentOption, lensKind } from './camzoom.js';

const labels = (o) => o.map((x) => x.label);

test('iPhone: named lenses, no track zoom', () => {
  const devices = [
    { deviceId: 'f', label: 'Front Camera' }, { deviceId: 'w', label: 'Back Camera' },
    { deviceId: 'u', label: 'Back Ultra Wide Camera' }, { deviceId: 't', label: 'Back Telephoto Camera' },
    { deviceId: 'tri', label: 'Back Triple Camera' },
  ];
  const o = zoomOptions({ devices, current: 'w', caps: {} });
  expect(labels(o)).toEqual(['0.5×', '1×', 'Tele', 'All lenses']);
  expect(o[0]).toMatchObject({ deviceId: 'u', zoom: null });
  expect(o.some((x) => x.deviceId === 'f')).toBe(false); // never the front camera
});

test('track zoom reaching below 1 gives the wide steps on the same camera', () => {
  const o = zoomOptions({ devices: [{ deviceId: 'a', label: 'camera2 0, facing back' }], current: 'a', caps: { zoom: { min: 0.5, max: 8 } } });
  expect(labels(o)).toEqual(['0.5×', '1×', '2×', '3×', '5×']);
  expect(o.every((x) => x.deviceId === 'a' && x.zoom != null)).toBe(true);
  // a widest end that is not a step is offered as it is
  expect(labels(zoomOptions({ devices: [], current: 'a', caps: { zoom: { min: 0.6, max: 2.5 } } }))).toEqual(['0.6×', '1×', '2×']);
});

test('Android: zoom from 1, an unnamed second back camera offered to try', () => {
  const devices = [{ deviceId: 'a', label: 'camera2 0, facing back' }, { deviceId: 'b', label: 'camera2 1, facing front' }, { deviceId: 'c', label: 'camera2 2, facing back' }];
  const o = zoomOptions({ devices, current: 'a', caps: { zoom: { min: 1, max: 4 } } });
  expect(labels(o)).toEqual(['1×', '2×', '3×', 'Lens 2']);
  expect(o[3].deviceId).toBe('c');
});

test('an ultra-wide lens is not offered twice when the zoom already goes wide', () => {
  const devices = [{ deviceId: 'w', label: 'Back Camera' }, { deviceId: 'u', label: 'Back Ultra Wide Camera' }];
  const o = zoomOptions({ devices, current: 'w', caps: { zoom: { min: 0.5, max: 3 } } });
  expect(labels(o)).toEqual(['0.5×', '1×', '2×', '3×']);
  expect(o[0].deviceId).toBe('w');
});

test('a webcam with nothing to choose gives a single option (the bar stays hidden)', () => {
  expect(labels(zoomOptions({ devices: [{ deviceId: 'x', label: 'HD Webcam' }], current: 'x', caps: {} }))).toEqual(['1×']);
});

test('the option the camera is on now', () => {
  const o = zoomOptions({ devices: [{ deviceId: 'w', label: 'Back Camera' }, { deviceId: 'u', label: 'Back Ultra Wide Camera' }], current: 'w', caps: { zoom: { min: 1, max: 5 } } });
  expect(currentOption(o, { deviceId: 'w', zoom: 2.01 }).label).toBe('2×');
  expect(currentOption(o, { deviceId: 'w', zoom: 1 }).label).toBe('1×');
  expect(lensKind('Back Dual Wide Camera')).toBe('multi');
});

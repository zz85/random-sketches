// materials.js - small shared helpers.
import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';

// a TSL constant from a three Color or Vector3 (vec3() of a Color object reads as zero)
export const v3 = (c) => (c.isColor ? vec3(c.r, c.g, c.b) : vec3(c.x, c.y, c.z));

export function textSprite(text, { size = 46, font = 'Georgia, serif', color = '#f1d9a0', weight = '400', spacing = 0.22, italic = false, glow = true } = {}) {
  const c = document.createElement('canvas'), g = c.getContext('2d');
  const f = `${italic ? 'italic ' : ''}${weight} ${size}px ${font}`;
  g.font = f;
  const chars = [...text]; const sp = size * spacing;
  const w = Math.ceil(chars.reduce((a, ch) => a + g.measureText(ch).width + sp, 0) + size * 0.6), h = Math.ceil(size * 1.6);
  c.width = w; c.height = h;
  g.font = f; g.textBaseline = 'middle';
  let x = size * 0.3;
  if (glow) { g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = size * 0.3; }
  g.fillStyle = color;
  for (const ch of chars) { g.fillText(ch, x, h / 2); x += g.measureText(ch).width + sp; }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return { tex: t, aspect: w / h };
}

// a label that keeps its size in pixels (scale is set per frame from the camera)
export function labelSprite(text, opts = {}) {
  const { tex, aspect } = textSprite(text, opts);
  const s = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: opts.depthTest ?? true, sizeAttenuation: false }));
  s.userData = { aspect, px: opts.px || 12 }; s.renderOrder = 6;
  if (opts.center) s.center.set(...opts.center);
  return s;
}

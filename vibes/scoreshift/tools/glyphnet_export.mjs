// Quantize the trained glyph classifier (/tmp/glyphnet.json from tools/glyphnet.mjs) to int8 per
// output row and write ../glyphnet-weights.js.
import fs from 'fs';
const J = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/glyphnet.json'));
const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
const layers = J.layers.map((L) => {
  const q = new Int8Array(L.W.length), sc = new Float32Array(L.nout);
  for (let o = 0; o < L.nout; o++) { let m = 0; for (let i = 0; i < L.nin; i++) m = Math.max(m, Math.abs(L.W[o * L.nin + i])); sc[o] = m / 127 || 1; for (let i = 0; i < L.nin; i++) q[o * L.nin + i] = Math.round(L.W[o * L.nin + i] / sc[o]); }
  return { nin: L.nin, nout: L.nout, W: b64(new Uint8Array(q.buffer)), s: b64(new Uint8Array(sc.buffer)), b: b64(new Uint8Array(Float32Array.from(L.b).buffer)) };
});
const out = `// Glyph classifier weights (int8 per row + float scales), trained by tools/glyphnet.mjs on
// synthetic Verovio pages in 5 fonts (tools/make_glyphset.mjs), not on the evaluation fixtures.
export const GLYPHNET = ${JSON.stringify({ labels: J.labels, layers })};\n`;
fs.writeFileSync(new URL('../glyphnet-weights.js', import.meta.url), out);
console.log('wrote glyphnet-weights.js', out.length, 'bytes');

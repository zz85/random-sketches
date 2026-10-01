// PDF input via pdf.js 6.3.289 (vendored legacy build: it polyfills APIs such as Uint8Array#toHex
// that older Safari / Chrome lack; loaded only when a PDF is opened) and a minimal PDF writer
// for exporting transposed pages. IMSLP / Internet Archive scans are usually JBIG2 or JPEG 2000
// images inside the PDF; pdf.js decodes both with its bundled wasm decoders.
const BASE = new URL('./vendor/pdfjs/', import.meta.url);
let lib = null;
async function pdfjs() {
  if (!lib) {
    lib = await import(new URL('pdf.min.mjs', BASE).href);
    lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', BASE).href;
  }
  return lib;
}

export async function isPdf(blob) {
  if (blob.type === 'application/pdf' || /\.pdf$/i.test(blob.name || '')) return true;
  const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  return String.fromCharCode(...head) === '%PDF-';
}

export async function openPdf(blob) {
  const { getDocument } = await pdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  return getDocument({ data, wasmUrl: new URL('wasm/', BASE).href, isEvalSupported: false, enableXfa: false }).promise;
}

// Render a page so its long side is about `px` pixels (scans are typically 300-600 dpi; 3000 px
// on a Letter/A4 page is ~270 dpi, plenty for staff spaces of 15+ px). White background.
export async function renderPage(doc, n, px = 3000) {
  const page = await doc.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = px / Math.max(vp1.width, vp1.height), vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, canvas: c, viewport: vp, background: 'white' }).promise;
  page.cleanup();
  return { canvas: c, widthPt: vp1.width, heightPt: vp1.height };
}

// ---------- writer: one JPEG per page, page size in points ----------
export function writePdf(pages) { // [{ jpeg: Uint8Array, w, h (pixels), widthPt, heightPt }]
  const enc = new TextEncoder(), parts = [], offs = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (i, body, stream) => {
    offs[i] = len;
    push(`${i} 0 obj\n${body}\n`);
    if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
    push('endobj\n');
  };
  const n = pages.length, kids = pages.map((_, k) => `${3 + 3 * k} 0 R`).join(' ');
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  pages.forEach((p, k) => {
    const pg = 3 + 3 * k, im = pg + 1, ct = pg + 2, W = +p.widthPt.toFixed(2), H = +p.heightPt.toFixed(2);
    const draw = enc.encode(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`);
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`);
    obj(im, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg);
    obj(ct, `<< /Length ${draw.length} >>`, draw);
  });
  const xref = len, count = 3 + 3 * n;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i = 1; i < count; i++) push(`${String(offs[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len); let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}

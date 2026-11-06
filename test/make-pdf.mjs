// Minimal PDF writer used by the browser smoke test (A4 page, Helvetica text lines).
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const escape = (text) => text.replace(/([\\()])/g, '\\$1')

export function makePdf(lines, file) {
  const content = ['BT', '/F1 20 Tf', '72 760 Td', '30 TL', ...lines.map((line, i) => `${i ? 'T* ' : ''}(${escape(line)}) Tj`), 'ET'].join('\n')
  const stream = deflateSync(Buffer.from(content, 'latin1'))
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ]
  const parts = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')]
  const offsets = []
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.concat(parts).length)
    parts.push(Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n'))
  }
  const startxref = Buffer.concat(parts).length
  const pad = (value) => String(value).padStart(10, '0')
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) trailer += `${pad(offset)} 00000 n \n`
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`
  parts.push(Buffer.from(trailer))
  const pdf = Buffer.concat(parts)
  if (file) writeFileSync(file, pdf)
  return pdf
}

if (import.meta.main && process.argv[2]) {
  makePdf(['ArtCraft Web preview', 'PdfCraft in WebAssembly', 'The quick brown fox jumps over the lazy dog.', 'Line four of the smoke test.'], process.argv[2])
}

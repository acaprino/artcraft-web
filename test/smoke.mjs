// Loads each built engine from dist/ in Node and exercises the public API on generated documents.
// Usage: node test/smoke.mjs [engine ...]   (default: all engines; exit code 1 on any failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { ENGINES, parseEngines, readPin, root, verifyDist } from '../scripts/common.mjs'
import { FIXTURES, SAMPLE_TEXT } from './fixtures.mjs'

function pngInfo(png) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (png.length < 33 || signature.some((byte, i) => png[i] !== byte)) throw new Error('not a PNG')
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const width = view.getUint32(16), height = view.getUint32(20)
  const idat = []
  for (let offset = 8; offset + 8 <= png.length;) {
    const length = view.getUint32(offset), type = String.fromCharCode(...png.slice(offset + 4, offset + 8))
    if (type === 'IDAT') idat.push(png.slice(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  return { width, height, distinct: new Set(raw).size }
}

const failures = []
const check = (engine, label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${engine}: ${label}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(`${engine}: ${label}`)
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

for (const engine of parseEngines(process.argv.slice(2))) {
  try {
    const problems = verifyDist(engine)
    check(engine, 'dist matches pin and provenance', !problems.length, problems.join('; '))
    const dist = join(root, 'dist', engine)
    const module = await import(pathToFileURL(join(dist, `${engine}.js`)).href)
    await module.default({ module_or_path: readFileSync(join(dist, `${engine}_bg.wasm`)) })
    const Document = module[ENGINES[engine].documentClass]
    const open = (bytes) => engine === 'pdfcraft' ? new Document(bytes, undefined) : new Document(bytes)
    const doc = open(FIXTURES[engine]())
    const meta = JSON.parse(doc.metadata())
    check(engine, 'metadata reports pinned version', meta.version === readPin(engine).tag && meta.pages.length >= 1, `${meta.engine} ${meta.version}, ${meta.pages.length} page(s)`)
    const png = doc.renderPage(0, 1)
    const info = pngInfo(png)
    check(engine, 'renderPage returns a non-blank PNG', info.width > 0 && info.height > 0 && info.distinct > 2, `${info.width}x${info.height}, ${png.length} bytes`)
    const larger = pngInfo(doc.renderPage(0, 2))
    check(engine, 'scale changes the output size', larger.width > info.width, `${larger.width}px at scale 2`)
    check(engine, 'pageText contains the sample text', doc.pageText(0).includes(SAMPLE_TEXT))
    check(engine, 'out-of-range page is a catchable error', throws(() => doc.renderPage(meta.pages.length + 5, 1)))
    check(engine, 'invalid input is a catchable error', throws(() => open(new Uint8Array([1, 2, 3]))))
    check(engine, 'empty input is a catchable error', throws(() => open(new Uint8Array(0))))
    const again = open(FIXTURES[engine]())
    check(engine, 'engine still works after errors', pngInfo(again.renderPage(0, 1)).width > 0)
    doc.free(); again.free()
  } catch (error) {
    check(engine, 'run', false, String(error?.stack ?? error))
  }
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exitCode = 1 } else console.log('\nall smoke checks passed')

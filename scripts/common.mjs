import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '..')

/** One entry per engine: the exported document class and the formats it opens. */
export const ENGINES = {
  pdfcraft: { documentClass: 'PdfDocument', formats: ['pdf'] },
  wordcraft: { documentClass: 'DocxDocument', formats: ['docx'] },
  gridcraft: { documentClass: 'XlsxDocument', formats: ['xlsx', 'xlsm'] },
  deckcraft: { documentClass: 'PptxDocument', formats: ['pptx', 'pptm'] },
}
export const ENGINE_NAMES = Object.keys(ENGINES)

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const readPin = (engine) => JSON.parse(readFileSync(join(root, 'pins', `${engine}.json`), 'utf8'))
export const exeSuffix = process.platform === 'win32' ? '.exe' : ''

export function parseEngines(args) {
  const names = args.filter((arg) => !arg.startsWith('--'))
  const unknown = names.filter((name) => !ENGINES[name])
  if (unknown.length) throw new Error(`Unknown engine: ${unknown.join(', ')} (valid: ${ENGINE_NAMES.join(', ')})`)
  return names.length ? names : ENGINE_NAMES
}

/** Checks the exact bytes in dist/<engine> against the pin and the recorded provenance. Returns problems. */
export function verifyDist(engine, dist = join(root, 'dist', engine)) {
  const problems = []
  const meta = ENGINES[engine]
  const pin = readPin(engine)
  let provenance
  try { provenance = JSON.parse(readFileSync(join(dist, 'provenance.json'), 'utf8')) } catch { return [`${engine}: missing or invalid provenance.json`] }
  if (provenance.engine !== engine || provenance.tag !== pin.tag || provenance.commit !== pin.commit) problems.push(`${engine}: dist was built from ${provenance.tag}@${provenance.commit}, pin is ${pin.tag}@${pin.commit}`)
  for (const name of [`${engine}.js`, `${engine}_bg.wasm`, `${engine}.d.ts`, 'LICENSE-MIT', 'LICENSE-APACHE', 'JCODE-NOTICE.txt']) if (!provenance.files?.[name]) problems.push(`${engine}: provenance does not list ${name}`)
  for (const [name, digest] of Object.entries(provenance.files ?? {})) {
    const file = join(dist, name)
    if (!existsSync(file)) problems.push(`${engine}: missing ${name}`)
    else if (sha256(readFileSync(file)) !== digest) problems.push(`${engine}: ${name} changed after the build`)
  }
  const wasmFile = join(dist, `${engine}_bg.wasm`)
  if (existsSync(wasmFile)) {
    const wasm = readFileSync(wasmFile)
    if (!WebAssembly.validate(wasm)) problems.push(`${engine}: invalid WebAssembly`)
    if (!wasm.includes(Buffer.from(pin.tag))) problems.push(`${engine}: wasm does not report the pinned version ${pin.tag}`)
  }
  const glueFile = join(dist, `${engine}.js`)
  if (existsSync(glueFile)) {
    const glue = readFileSync(glueFile, 'utf8')
    if (!glue.includes(`export class ${meta.documentClass}`)) problems.push(`${engine}: missing export ${meta.documentClass}`)
    if (!glue.includes(`${engine}_bg.wasm`) || /https?:\/\//.test(glue)) problems.push(`${engine}: bindings must load only the local wasm`)
  }
  const extra = existsSync(dist) ? readdirSync(dist).filter((name) => !provenance.files?.[name] && name !== 'provenance.json') : []
  if (extra.length) problems.push(`${engine}: files not in provenance: ${extra.join(', ')}`)
  return problems
}

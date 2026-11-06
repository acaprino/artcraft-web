// Release build: builds (or reuses) dist/, verifies it, then packs one npm tarball per engine into release/.
// Usage: node scripts/release.mjs [engine ...] [--skip-build] [--skip-test]
//   release/<scope>-<engine>-<version>.tgz   installable with `npm i ./file.tgz` or from any URL
//   release/SHA256SUMS, release/manifest.json
// release/ always holds only the current release (it is wiped first).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENGINES, ENGINE_NAMES, parseEngines, readPin, root, sha256, verifyDist } from './common.mjs'
import { FIXTURES, SAMPLE_TEXT } from '../test/fixtures.mjs'

const SCOPE = '@artcraft-web'
const args = process.argv.slice(2)
const engines = parseEngines(args)
const root_pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (cmd, argv, cwd = root) => execFileSync(cmd, argv, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd.endsWith('.cmd') })

if (!args.includes('--skip-build')) run('node', [join(root, 'build.mjs'), ...engines])
for (const engine of engines) {
  const problems = verifyDist(engine)
  if (problems.length) throw new Error(`dist/${engine} is not releasable:\n${problems.join('\n')}`)
}
if (!args.includes('--skip-test')) run('node', [join(root, 'test/smoke.mjs'), ...engines])

const release = join(root, 'release')
rmSync(release, { recursive: true, force: true })
mkdirSync(release, { recursive: true })
const stageRoot = mkdtempSync(join(tmpdir(), 'artcraft-release-'))
const manifest = { version: root_pkg.version, scope: SCOPE, packages: [] }

const readme = (engine, pin, name) => `# ${name}

${ENGINES[engine].documentClass} — read-only preview of ${ENGINES[engine].formats.map((f) => `.${f}`).join(', ')} files, compiled to WebAssembly from
[${pin.repo.split('/').slice(-2).join('/')}](${pin.repo}) ${pin.tag} (${pin.commit.slice(0, 12)}).

\`\`\`js
import init, { ${ENGINES[engine].documentClass} } from '${name}'

// In a bundler (Vite, webpack 5, esbuild) the default loader resolves the wasm next to the module:
await init()
// or pass the bytes/URL yourself (Node, custom hosting):
// await init({ module_or_path: await (await fetch(wasmUrl)).arrayBuffer() })

const doc = new ${ENGINES[engine].documentClass}(bytes${engine === 'pdfcraft' ? ', password /* or undefined */' : ''})
const meta = JSON.parse(doc.metadata())      // { engine, version, pages: [{ width, height, ... }], ... }
const png = doc.renderPage(0, 1.5)           // Uint8Array (PNG), scale 1 = 96 dpi-ish
const text = JSON.parse(doc.pageText(0))     // [{ text, x, y, width, height, fontSize, ... }]
doc.free()
\`\`\`

- Run it in a Web Worker: parsing and rendering are synchronous and CPU-bound.
- Errors (invalid or oversized input, page out of range) are thrown as catchable strings.
${engine === 'gridcraft' ? '- Call `renderPage(i)` before `pageText(i)`: the text layer of a sheet is produced by rendering it.\n' : ''}- \`${name}/wasm\` resolves to the \`.wasm\` file for hosting it as a static asset.
- Licences: MIT OR Apache-2.0 (upstream); bundled fonts are under the OFL. All notices ship in this package.
`

for (const engine of engines) {
  const pin = readPin(engine)
  const name = `${SCOPE}/${engine}`
  const stage = join(stageRoot, engine)
  mkdirSync(stage, { recursive: true })
  const dist = join(root, 'dist', engine)
  const files = readdirSync(dist)
  for (const file of files) copyFileSync(join(dist, file), join(stage, file))
  writeFileSync(join(stage, 'README.md'), readme(engine, pin, name))
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify({
    name, version: root_pkg.version, description: `${ENGINES[engine].documentClass} WebAssembly preview engine (${pin.tag})`,
    type: 'module', main: `./${engine}.js`, module: `./${engine}.js`, types: `./${engine}.d.ts`,
    exports: { '.': { types: `./${engine}.d.ts`, import: `./${engine}.js`, default: `./${engine}.js` }, './wasm': `./${engine}_bg.wasm`, './package.json': './package.json' },
    sideEffects: false, license: 'MIT OR Apache-2.0',
    artcraft: { engine, upstream: pin.repo, tag: pin.tag, commit: pin.commit, formats: ENGINES[engine].formats },
    files: [...files, 'README.md'],
  }, null, 2)}\n`)
  run(npm, ['pack', '--pack-destination', release, '--silent'], stage)
}
rmSync(stageRoot, { recursive: true, force: true })

const sums = []
for (const file of readdirSync(release).filter((f) => f.endsWith('.tgz')).sort()) {
  const bytes = readFileSync(join(release, file))
  const engine = ENGINE_NAMES.find((candidate) => file.includes(`-${candidate}-`))
  sums.push(`${sha256(bytes)}  ${file}`)
  manifest.packages.push({ engine, file, bytes: bytes.length, sha256: sha256(bytes), tag: readPin(engine).tag, commit: readPin(engine).commit })
}
writeFileSync(join(release, 'SHA256SUMS'), `${sums.join('\n')}\n`)
writeFileSync(join(release, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

// Install every tarball into a clean project and use it through the package entry points.
if (!args.includes('--skip-test')) {
  const consumer = mkdtempSync(join(tmpdir(), 'artcraft-consumer-'))
  try {
    writeFileSync(join(consumer, 'package.json'), '{"type":"module","private":true}')
    run(npm, ['install', '--no-audit', '--no-fund', '--silent', ...manifest.packages.map((p) => join(release, p.file))], consumer)
    for (const { engine } of manifest.packages) {
      const name = `${SCOPE}/${engine}`
      writeFileSync(join(consumer, `check-${engine}.mjs`), `
        import { readFileSync } from 'node:fs'
        import { fileURLToPath } from 'node:url'
        import * as engine from '${name}'
        await engine.default({ module_or_path: readFileSync(fileURLToPath(import.meta.resolve('${name}/wasm'))) })
        const bytes = new Uint8Array(JSON.parse(readFileSync('fixture-${engine}.json', 'utf8')))
        const doc = new engine.${ENGINES[engine].documentClass}(bytes${engine === 'pdfcraft' ? ', undefined' : ''})
        const png = doc.renderPage(0, 1)
        if (png[1] !== 0x50 || !doc.pageText(0).includes(${JSON.stringify(SAMPLE_TEXT)})) throw new Error('${name} failed')
        console.log('ok   ${name} works when installed from its tarball')
      `)
      writeFileSync(join(consumer, `fixture-${engine}.json`), JSON.stringify([...FIXTURES[engine]()]))
      run('node', [`check-${engine}.mjs`], consumer)
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true })
  }
}
console.log(`\nrelease ${root_pkg.version}:`)
for (const p of manifest.packages) console.log(`  release/${p.file}  ${(p.bytes / 1e6).toFixed(1)} MB  ${p.tag}`)
if (!existsSync(join(release, 'SHA256SUMS'))) throw new Error('release incomplete')

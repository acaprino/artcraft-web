// Builds dist/<engine>/ (wasm-bindgen web package) for the pinned upstream releases.
// Usage: node build.mjs [engine ...] [--keep-target]   (default: all engines, one at a time)
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { ENGINES, exeSuffix, parseEngines, readPin, root, sha256, verifyDist } from './scripts/common.mjs'

const keepTarget = process.argv.includes('--keep-target')
const TARGET = 'wasm32-unknown-unknown'
const EPAINT_NOTICES = ['UFL.txt', 'OFL.txt', 'Hack-Regular.txt', 'emoji-icon-font-mit-license.txt']
const run = (cmd, args, cwd = root, env = process.env) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env })
const out = (cmd, args, cwd = root, env = process.env) => execFileSync(cmd, args, { cwd, encoding: 'utf8', env, maxBuffer: 1 << 28 }).trim()

/** Ambient compiler overrides must not change an artifact built from the same pin. */
function compilerEnv(pin, extra) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(RUSTFLAGS|RUSTDOCFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_ENCODED_RUSTDOCFLAGS|RUSTC|RUSTDOC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTC_BOOTSTRAP)$/i.test(name) || /^CARGO_(BUILD|PROFILE|TARGET)_/i.test(name)) delete env[name]
  }
  return { ...env, RUSTUP_TOOLCHAIN: pin.rust, CARGO_INCREMENTAL: '0', CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '1', ...extra }
}

function ensureWasmTarget(pin) {
  const installed = out('rustup', ['target', 'list', '--installed', '--toolchain', pin.rust])
  if (!installed.split(/\s+/).includes(TARGET)) run('rustup', ['target', 'add', TARGET, '--toolchain', pin.rust])
}

function ensureBindgen(pin) {
  const bin = join(root, '.cache/tools', `wasm-bindgen-${pin.wasmBindgen}`, 'bin', `wasm-bindgen${exeSuffix}`)
  if (!existsSync(bin)) run('cargo', ['install', 'wasm-bindgen-cli', '--version', pin.wasmBindgen, '--locked', '--root', join(root, '.cache/tools', `wasm-bindgen-${pin.wasmBindgen}`)])
  if (out(bin, ['--version']) !== `wasm-bindgen ${pin.wasmBindgen}`) throw new Error(`${bin} does not match wasm-bindgen ${pin.wasmBindgen}`)
  return bin
}

/** The upstream checkout is disposable; every adaptation is replayed from packages/<engine>/preview. */
function prepareSource(engine, pin) {
  const src = join(root, '.cache', engine)
  if (!existsSync(join(src, 'Cargo.toml'))) run('git', ['clone', '--depth', '1', '--branch', pin.tag, pin.repo, src])
  if (out('git', ['-C', src, 'rev-parse', 'HEAD']) !== pin.commit) throw new Error(`.cache/${engine} does not match pins/${engine}.json (delete .cache/${engine} to re-clone)`)
  run('git', ['-C', src, 'restore', '--source=HEAD', '--worktree', '--', '.'])
  const overlay = join(root, 'packages', engine, 'preview')
  const dest = join(src, 'jcode-preview')
  rmSync(dest, { recursive: true, force: true })
  cpSync(overlay, dest, { recursive: true })
  const manifest = readFileSync(join(src, 'Cargo.toml'), 'utf8')
  const members = /^members\s*=\s*\[([^\]]*)\]/m
  if (!members.test(manifest)) throw new Error(`${engine}: upstream workspace members need review`)
  writeFileSync(join(src, 'Cargo.toml'), manifest.replace(members, (_, entries) => `members = [${entries.trimEnd().replace(/,$/, '')}, "jcode-preview"]`))
  const lockFile = join(src, 'Cargo.lock')
  const lock = readFileSync(lockFile, 'utf8')
  const bindgenVersion = /\[\[package\]\]\s+name = "wasm-bindgen"\s+version = "([^"]+)"/.exec(lock)?.[1]
  if (bindgenVersion !== pin.wasmBindgen) throw new Error(`${engine}: pin wasmBindgen ${pin.wasmBindgen} != upstream Cargo.lock ${bindgenVersion}`)
  // Cargo adds only our crate to the upstream lock; every upstream package must keep its exact version.
  const packages = (text) => new Set([...text.matchAll(/\[\[package\]\]\s+name = "([^"]+)"\s+version = "([^"]+)"/g)].map((m) => `@`))
  const before = packages(lock)
  out('cargo', ['metadata', '--format-version', '1'], src, { ...process.env, RUSTUP_TOOLCHAIN: pin.rust })
  const after = packages(readFileSync(lockFile, 'utf8'))
  const lost = [...before].filter((name) => !after.has(name))
  const added = [...after].filter((name) => !before.has(name))
  if (lost.length || added.some((name) => !name.startsWith(`jcode__preview@`))) throw new Error(`: the lock changed beyond our crate (removed: ; added: )`)
  return { src, locked: true }
}

function epaintNotices(src, env) {
  const lock = readFileSync(join(src, 'Cargo.lock'), 'utf8')
  const entry = /name = "epaint_default_fonts"\s+version = "([^"]+)"\s+source = "([^"]+)"(?:\s+checksum = "([a-f0-9]{64})")?/.exec(lock)
  if (!entry) return {}
  const [, version, source, checksum] = entry
  const cargoHome = env.CARGO_HOME ?? join(homedir(), '.cargo')
  const notice = (name, bytes) => [`epaint-${name}`, bytes]
  if (source.startsWith('git+')) {
    const rev = source.split('#').at(-1).slice(0, 7)
    const checkouts = join(cargoHome, 'git/checkouts')
    for (const repo of existsSync(checkouts) ? readdirSync(checkouts) : []) {
      const fonts = join(checkouts, repo, rev, 'crates/epaint_default_fonts/fonts')
      if (existsSync(fonts)) return Object.fromEntries(readdirSync(fonts).filter((name) => name.endsWith('.txt')).map((name) => notice(name, readFileSync(join(fonts, name)))))
    }
    throw new Error(`epaint_default_fonts git checkout ${rev} not found in the cargo git cache`)
  }
  const cache = join(cargoHome, 'registry/cache')
  for (const registry of existsSync(cache) ? readdirSync(cache) : []) {
    const archive = join(cache, registry, `epaint_default_fonts-${version}.crate`)
    if (!existsSync(archive)) continue
    if (sha256(readFileSync(archive)) !== checksum) throw new Error('epaint_default_fonts checksum mismatch')
    return Object.fromEntries(EPAINT_NOTICES.map((name) => notice(name, execFileSync('tar', ['-xzOf', archive, `epaint_default_fonts-${version}/fonts/${name}`], { maxBuffer: 1 << 24 }))))
  }
  throw new Error('epaint_default_fonts crate not found in the cargo registry cache')
}

function build(engine, fontDir) {
  const pin = readPin(engine)
  const { src, locked } = prepareSource(engine, pin)
  ensureWasmTarget(pin)
  const bindgen = ensureBindgen(pin)
  const targetDir = join(process.env.ARTCRAFT_TARGET_DIR ?? join(root, '.cache/target'), engine)
  const env = compilerEnv(pin, { CARGO_TARGET_DIR: targetDir, JCODE_CRAFT_ENGINE_VERSION: pin.tag, JCODE_CRAFT_FONT_DIR: fontDir })
  const rustc = out('rustc', ['--version'], src, env)
  if (!rustc.startsWith(`rustc ${pin.rust} `)) throw new Error(`${engine}: toolchain is "${rustc}", pin is ${pin.rust}`)
  try {
    run('cargo', ['build', '--release', ...(locked ? ['--locked'] : []), '--target', TARGET, '-p', `jcode_${engine}_preview`], src, env)
    const wasm = join(targetDir, TARGET, 'release', `jcode_${engine}_preview.wasm`)
    const dist = join(root, 'dist', engine)
    rmSync(dist, { recursive: true, force: true })
    mkdirSync(dist, { recursive: true })
    run(bindgen, [wasm, '--target', 'web', '--out-dir', dist, '--out-name', engine])
    const raw = join(dist, `${engine}_bg.wasm`)
    run('node', [join(root, 'node_modules/binaryen/bin/wasm-opt'), '-Oz', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', '--enable-sign-ext', '--enable-mutable-globals', '--strip-debug', '--strip-producers', '--converge', raw, '-o', raw])
    for (const file of ['LICENSE-APACHE', 'LICENSE-MIT', 'NOTICE', 'ATTRIBUTION.md']) if (existsSync(join(src, file))) copyFileSync(join(src, file), join(dist, file))
    for (const fonts of new Set([join(src, 'assets/fonts'), fontDir])) {
      if (existsSync(fonts)) for (const file of readdirSync(fonts).filter((name) => /^(?:OFL|LICENSE)/i.test(name))) copyFileSync(join(fonts, file), join(dist, file))
    }
    const needsEpaint = engine === 'gridcraft' || engine === 'deckcraft'
    if (needsEpaint) for (const [name, bytes] of Object.entries(epaintNotices(src, env))) writeFileSync(join(dist, name), bytes)
    writeFileSync(join(dist, 'JCODE-NOTICE.txt'), `${engine} ${pin.tag} (${pin.commit})\nFonts from the pinned Wordcraft release ${readPin('wordcraft').tag}.\n${needsEpaint ? 'Epaint fallback fonts from the upstream-locked epaint_default_fonts crate; their licence notices are included.\n' : ''}Original licence notices are included beside this file.\n`)
    const files = {}
    for (const file of readdirSync(dist).sort()) files[file] = sha256(readFileSync(join(dist, file)))
    writeFileSync(join(dist, 'provenance.json'), `${JSON.stringify({ schemaVersion: 1, engine, tag: pin.tag, commit: pin.commit, rust: pin.rust, wasmBindgen: pin.wasmBindgen, files }, null, 2)}\n`)
    const problems = verifyDist(engine)
    if (problems.length) throw new Error(problems.join('\n'))
    console.log(`dist/${engine} ready: ${ENGINES[engine].documentClass}, ${readFileSync(raw).length} bytes wasm`)
  } finally {
    if (!keepTarget) rmSync(targetDir, { recursive: true, force: true })
  }
}

const engines = parseEngines(process.argv.slice(2))
const fontSource = prepareSource('wordcraft', readPin('wordcraft')).src
const fontDir = join(fontSource, 'assets/fonts')
for (const engine of engines) build(engine, fontDir)
console.log(relative(root, join(root, 'dist')), 'built:', engines.join(', '))

// Moves a pin to a newer upstream release. Never builds; it only rewrites pins/<engine>.json and drops the stale checkout.
// Usage: node scripts/update-upstream.mjs [engine ...] [--check] [--tag vX.Y.Z]
//   --check      report current vs latest release and change nothing
//   --tag <tag>  use this tag instead of the latest vX.Y.Z (single engine only)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEngines, readPin, root } from './common.mjs'

const args = process.argv.slice(2)
const check = args.includes('--check')
const tagIndex = args.indexOf('--tag')
const forcedTag = tagIndex >= 0 ? args[tagIndex + 1] : undefined
const engines = parseEngines(args.filter((arg, i) => arg !== forcedTag || i !== tagIndex + 1))
if (forcedTag && engines.length !== 1) throw new Error('--tag needs exactly one engine')
const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8' }).trim()
const semver = (tag) => tag.slice(1).split('.').map(Number)
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0 }

let changed = false
for (const engine of engines) {
  const pin = readPin(engine)
  const refs = git('ls-remote', '--tags', pin.repo, 'refs/tags/v*').split('\n').filter(Boolean).map((line) => {
    const [commit, ref] = line.split(/\s+/)
    return { commit, tag: ref.replace('refs/tags/', '').replace(/\^\{\}$/, ''), peeled: ref.endsWith('^{}') }
  })
  const tags = new Map()
  for (const { tag, commit, peeled } of refs) if (/^v\d+\.\d+\.\d+$/.test(tag) && (peeled || !tags.has(tag))) tags.set(tag, commit)
  const target = forcedTag ?? [...tags.keys()].sort(newer).at(-1)
  if (!tags.has(target)) throw new Error(`${engine}: tag ${target} not found upstream`)
  const status = target === pin.tag ? 'up to date' : newer(target, pin.tag) > 0 ? 'UPDATE AVAILABLE' : 'older than pin'
  console.log(`${engine}: pinned ${pin.tag}, target ${target} (${tags.get(target).slice(0, 12)}) — ${status}`)
  if (check || target === pin.tag) continue

  // Read what the build will assert on, from the released tree itself.
  const probe = mkdtempSync(join(tmpdir(), 'artcraft-pin-'))
  try {
    git('clone', '--depth', '1', '--branch', target, pin.repo, probe)
    if (git('-C', probe, 'rev-parse', 'HEAD') !== tags.get(target)) throw new Error(`${engine}: cloned commit differs from the tag's commit`)
    const lock = readFileSync(join(probe, 'Cargo.lock'), 'utf8')
    const wasmBindgen = /\[\[package\]\]\s+name = "wasm-bindgen"\s+version = "([^"]+)"/.exec(lock)?.[1]
    if (!wasmBindgen) throw new Error(`${engine}: wasm-bindgen not in the upstream Cargo.lock`)
    const next = { ...pin, tag: target, commit: tags.get(target), wasmBindgen }
    if (wasmBindgen !== pin.wasmBindgen) console.log(`  wasm-bindgen ${pin.wasmBindgen} -> ${wasmBindgen}: also update "wasm-bindgen = \\"=...\\"" in packages/${engine}/preview/Cargo.toml (all engines share it)`)
    writeFileSync(join(root, 'pins', `${engine}.json`), `${JSON.stringify(next)}\n`)
    rmSync(join(root, '.cache', engine), { recursive: true, force: true })
    changed = true
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}
if (changed) console.log('\nPins updated. Next: npm run release (rebuilds, tests, packs). Update README/AGENTS notes if behavior changed. If wordcraft moved, rebuild every engine: its fonts are shared.')

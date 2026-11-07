// Unattended pipeline: move pins to the latest upstream releases, rebuild, test, bump the minor version, pack the release.
// Usage: node scripts/update-and-release.mjs [engine ...] [--force] [--commit]
//   --force   rebuild and re-release even when no upstream release is newer
//   --commit  commit pins, overlay changes and version on success (never pushes)
// Everything (stdout, stderr, errors, crashes) goes to logs/update-<timestamp>.log; the last failure summary to logs/last-error.txt.
// On any failure pins, overlay Cargo.toml and version are restored; dist/ may then hold a partial new build.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINE_NAMES, ENGINES, readPin, root } from './common.mjs'

const args = process.argv.slice(2)
const force = args.includes('--force')
const commit = args.includes('--commit')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const logDir = join(root, 'logs')
mkdirSync(logDir, { recursive: true })
const logFile = join(logDir, `update-${stamp}.log`)
const errorFile = join(logDir, 'last-error.txt')

// Synchronous appends: nothing is lost if the process dies right after.
const write = (text) => { try { appendFileSync(logFile, text) } catch { /* the console still has it */ } }
const say = (text) => { const line = `[${new Date().toLocaleString('it-IT')}] ${text}`; console.log(line); write(`${line}\n`) }
const tail = (lines = 40) => { try { return readFileSync(logFile, 'utf8').split('\n').slice(-lines).join('\n') } catch { return '' } }

let restore = () => {}
let finished = false
function fail(reason) {
  if (finished) return
  finished = true
  say(`FAILED: ${reason}`)
  try { restore(); say('pins, overlay Cargo.toml and version restored; dist/ may hold a partial new build (run "npm run build" to realign it)') } catch (error) { say(`restore failed: ${error}`) }
  writeFileSync(errorFile, `${new Date().toISOString()}\nlog: ${logFile}\nreason: ${reason}\n\n--- last log lines ---\n${tail()}\n`)
  process.exitCode = 1
}
process.on('uncaughtException', (error) => fail(`uncaught exception: ${error?.stack ?? error}`))
process.on('unhandledRejection', (error) => fail(`unhandled rejection: ${error?.stack ?? error}`))
process.on('SIGINT', () => { fail('interrupted (Ctrl+C or window closed)'); process.exit(130) })
process.on('SIGTERM', () => { fail('terminated'); process.exit(143) })
process.on('exit', (code) => { if (!finished && code !== 0) fail(`process exited with code ${code}`); write(`[${new Date().toLocaleString('it-IT')}] exit code ${process.exitCode ?? code}\n`) })

const run = (cmd, argv, env = {}) => new Promise((resolve) => {
  write(`$ ${cmd} ${argv.join(' ')}\n`)
  const child = spawn(cmd, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { process.stdout.write(chunk); write(chunk.toString()) })
  child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 1)))
  child.on('error', (error) => { say(`cannot start ${cmd}: ${error}`); resolve(1) })
})
const step = async (title, cmd, argv, env) => {
  say(`>>> ${title}`)
  const code = await run(cmd, argv, env)
  if (code !== 0) throw new Error(`${title} failed (exit ${code})`)
  say(`<<< ${title}: ok`)
}
const git = (...argv) => new Promise((resolve) => {
  const child = spawn('git', argv, { cwd: root, stdio: 'pipe' })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  child.on('close', (code) => resolve({ code, out: out.trim() }))
  child.on('error', (error) => resolve({ code: 1, out: String(error) }))
})

async function main() {
  say(`start: node ${process.version}, args "${args.join(' ')}", log ${logFile}`)
  const names = args.filter((arg) => !arg.startsWith('--'))
  const unknown = names.filter((name) => !ENGINES[name])
  if (unknown.length) throw new Error(`unknown engine: ${unknown.join(', ')} (valid: ${ENGINE_NAMES.join(', ')})`)
  const engines = names.length ? names : ENGINE_NAMES

  // Keep the machine awake until this process exits (a sleep would stall an hours-long build).
  spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [W.P]::SetThreadExecutionState(2147483649) | Out-Null; while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep 10 }`], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()

  const dirty = await git('status', '--porcelain', '--', 'pins', 'packages', 'package.json', 'package-lock.json', 'build.mjs', 'scripts')
  if (dirty.out) throw new Error(`uncommitted changes in tracked project files, commit or stash first:\n${dirty.out}`)

  const saved = {
    files: Object.fromEntries([
      ...ENGINE_NAMES.map((e) => join('pins', `${e}.json`)),
      ...ENGINE_NAMES.map((e) => join('packages', e, 'preview', 'Cargo.toml')),
      'package.json', 'package-lock.json',
    ].map((file) => [file, readFileSync(join(root, file), 'utf8')])),
  }
  restore = () => { for (const [file, text] of Object.entries(saved.files)) writeFileSync(join(root, file), text) }
  const pinsNow = () => Object.fromEntries(ENGINE_NAMES.map((e) => [e, readPin(e)]))
  const before = pinsNow()

  await step('upstream: update pins', process.execPath, [join(root, 'scripts/update-upstream.mjs'), ...engines])
  const after = pinsNow()
  const changed = ENGINE_NAMES.filter((e) => before[e].tag !== after[e].tag)
  say(changed.length ? `new upstream releases: ${changed.map((e) => `${e} ${before[e].tag} -> ${after[e].tag}`).join(', ')}` : 'no newer upstream release')
  if (!changed.length && !force) { say('nothing to do (use --force to rebuild anyway)'); return }

  const bindgen = new Set(Object.values(after).map((pin) => pin.wasmBindgen))
  if (bindgen.size !== 1) throw new Error(`engines disagree on wasm-bindgen (${[...bindgen].join(', ')}): align them manually`)
  const [version] = bindgen
  for (const e of ENGINE_NAMES) {
    const file = join('packages', e, 'preview', 'Cargo.toml')
    const text = readFileSync(join(root, file), 'utf8')
    const next = text.replace(/wasm-bindgen = "=[^"]+"/, `wasm-bindgen = "=${version}"`)
    if (next !== text) { writeFileSync(join(root, file), next); say(`${file}: wasm-bindgen =${version}`) }
  }

  const rebuild = changed.includes('wordcraft') ? ENGINE_NAMES : (changed.length ? changed : engines)
  for (const engine of rebuild) {
    let ok = false
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      say(`>>> build ${engine} (attempt ${attempt}/3)`)
      ok = (await run(process.execPath, [join(root, 'build.mjs'), engine], { CARGO_BUILD_JOBS: '1' })) === 0
      say(ok ? `<<< build ${engine}: ok` : `build ${engine} failed${attempt < 3 ? ', retrying (0xc0000409 = machine out of memory)' : ''}`)
    }
    if (!ok) throw new Error(`build ${engine} failed after 3 attempts: see the compiler error above; adapt packages/${engine}/preview if the upstream API changed`)
  }

  await step('test: node smoke', process.execPath, [join(root, 'test/smoke.mjs')])
  await step('test: browser', process.execPath, [join(root, 'test/browser.mjs')])

  const pkgText = saved.files['package.json']
  const pkg = JSON.parse(pkgText)
  const [major, minor] = pkg.version.split('.').map(Number)
  const next = `${major}.${minor + 1}.0`
  writeFileSync(join(root, 'package.json'), pkgText.replace(`"version": "${pkg.version}"`, `"version": "${next}"`))
  const lock = JSON.parse(saved.files['package-lock.json'])
  lock.version = next
  if (lock.packages?.['']) lock.packages[''].version = next
  writeFileSync(join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
  say(`version ${pkg.version} -> ${next}`)

  await step('release: pack and install check', process.execPath, [join(root, 'scripts/release.mjs'), '--skip-build'])

  const notes = ENGINE_NAMES.map((e) => `${e} ${after[e].tag}`).join(', ')
  if (commit) {
    await git('add', 'pins', 'packages', 'package.json', 'package-lock.json')
    const result = await git('commit', '-m', `release ${next}: upstream ${notes}`)
    say(result.code === 0 ? `committed release ${next} (no push)` : `commit failed (release files are fine): ${result.out}`)
  } else say('not committed: review "git diff" and commit, or rerun with --commit')
  rmSync(errorFile, { force: true })
  say(`DONE release ${next}: ${notes}`)
}

try {
  await main()
  finished = true
} catch (error) {
  fail(error?.message ?? String(error))
}

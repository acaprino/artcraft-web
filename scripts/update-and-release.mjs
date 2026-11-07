// Unattended, resumable pipeline: move pins to the latest upstream releases, rebuild, test, bump the minor version, pack the release.
// Usage: node scripts/update-and-release.mjs [engine ...] [--force] [--commit] [--resume] [--rollback] [--status]
//   (no flag)   continues an unfinished update automatically when logs/update-state.json says so, otherwise starts a new one
//   --force     rebuild and re-release even when no upstream release is newer
//   --commit    commit pins, overlay changes and version on success (never pushes)
//   --resume    like no flag, and also adopts an interrupted run that left no state file (pins differ from git HEAD)
//   --rollback  discard the unfinished update (pins, packages, version back to HEAD; state, .cache checkouts, cargo targets removed)
//   --status    print the progress tracked in logs/update-state.json and exit
// Progress is tracked step by step in logs/update-state.json (written atomically before and after every step), so killing
// the process, a reboot or a crash loses at most the step in progress. Cargo targets are kept until their engine is done,
// so an interrupted compilation continues instead of restarting.
// Every output line, error and crash goes to logs/update-<timestamp>.log; the last failure summary to logs/last-error.txt.
// A failure AFTER the pins moved is not rolled back: the new pins and the .cache checkout are what the fix needs.
// For those failures logs/llm-handoff.md holds the extracted compiler errors and a ready-made prompt for the LLM.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINE_NAMES, ENGINES, readPin, root, verifyDist } from './common.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const force = flag('--force')
const commit = flag('--commit')
const resumeFlag = flag('--resume')
const rollback = flag('--rollback')
const statusOnly = flag('--status')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const logDir = join(root, 'logs')
mkdirSync(logDir, { recursive: true })
const logFile = join(logDir, `update-${stamp}.log`)
const errorFile = join(logDir, 'last-error.txt')
const handoffFile = join(logDir, 'llm-handoff.md')
const stateFile = join(logDir, 'update-state.json')
const targetBase = process.env.ARTCRAFT_TARGET_DIR ?? join(root, '.cache/target')

// Synchronous appends: nothing is lost if the process dies right after.
const write = (text) => { try { appendFileSync(logFile, text) } catch { /* the console still has it */ } }
const say = (text) => { const line = `[${new Date().toLocaleString('it-IT')}] ${text}`; console.log(line); write(`${line}\n`) }
const tail = (lines = 40) => { try { return readFileSync(logFile, 'utf8').split('\n').slice(-lines).join('\n') } catch { return '' } }

const MEMORY_CRASH = /0xc0000409|STATUS_STACK_BUFFER_OVERRUN|memory allocation of \d+ bytes failed/

// ---- progress tracking --------------------------------------------------------------------------------------------
let state = null
const now = () => new Date().toISOString()
function saveState() {
  if (!state) return
  state.updatedAt = now()
  state.lastLog = logFile
  const temp = `${stateFile}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(temp, stateFile)
}
const loadState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null } }
/** Records a step. Everything except "done" is treated as pending when the update is resumed. */
function mark(step, status, extra = {}) {
  const target = step.startsWith('build:') ? (state.build[step.slice(6)] ??= { status: 'pending', attempts: 0 }) : (state.steps[step] ??= {})
  Object.assign(target, { status, at: now(), ...extra })
  saveState()
}
const isDone = (step) => (step.startsWith('build:') ? state.build[step.slice(6)]?.status : state.steps[step]?.status) === 'done'

function printStatus() {
  const saved = loadState()
  if (!saved) { console.log('no update in progress (no logs/update-state.json)'); return }
  console.log(`update ${saved.status} since ${saved.startedAt} (updated ${saved.updatedAt}), base ${saved.baseCommit?.slice(0, 8)}`)
  if (saved.error) console.log(`error: ${saved.error}`)
  for (const [engine, pin] of Object.entries(saved.pins ?? {})) console.log(`  pin ${engine}: ${pin.from} -> ${pin.to}`)
  for (const engine of saved.rebuild ?? []) console.log(`  build ${engine}: ${saved.build?.[engine]?.status ?? 'pending'} (attempts ${saved.build?.[engine]?.attempts ?? 0})`)
  for (const [step, info] of Object.entries(saved.steps ?? {})) console.log(`  ${step}: ${info.status}`)
  console.log(`  version ${saved.versionFrom} -> ${saved.versionTo}`)
  console.log(`resume: update-and-release.bat   rollback: update-and-release.bat --rollback`)
}

// ---- failure handling ---------------------------------------------------------------------------------------------
/** Compiler and cargo errors only: rustc blocks start with "error" and end at the first blank line. */
function extractErrors(output, limit = 160) {
  const lines = output.split(/\r?\n/)
  const picked = []
  for (let i = 0; i < lines.length && picked.length < limit; i++) {
    const line = lines[i]
    if (/^error(\[E\d+\])?: /.test(line) && !/could not compile|aborting due to/.test(line)) {
      for (; i < lines.length && lines[i].trim() !== '' && picked.length < limit; i++) picked.push(lines[i])
      picked.push('')
    } else if (/^Error: (?!Command failed)/.test(line)) picked.push(line, '')
  }
  return picked.join('\n').trim()
}

let finished = false
let failedBuild = null // { engine, output } of the last failed build or test

function writeHandoff(reason) {
  const engine = failedBuild?.engine
  const errors = failedBuild ? extractErrors(failedBuild.output) : ''
  const memory = failedBuild && MEMORY_CRASH.test(failedBuild.output) && !errors
  const pinLines = ENGINE_NAMES.map((e) => {
    const moved = state?.pins?.[e]
    return `- ${e}: ${moved ? `${moved.from} -> ${moved.to}` : readPin(e).tag}`
  }).join('\n')
  const text = `# Aggiornamento upstream interrotto

Data: ${now()}
Motivo: ${reason}
Log completo: ${logFile}
Stato dei passi: ${stateFile}
${engine ? `Motore che ha fallito: ${engine}\n` : ''}
## Pin attuali (già spostati, non annullati)
${pinLines}

${memory
    ? `## Esito
Crash per memoria insufficiente (0xc0000409), non un errore del codice. Nessuna modifica necessaria: chiudere i programmi pesanti e rilanciare \`update-and-release.bat\` (riprende da dove si è fermato).
`
    : `## Errori estratti
\`\`\`
${errors || '(nessun errore del compilatore estratto: leggere la coda del log)'}
\`\`\`

## Coda del log
\`\`\`
${tail(40)}
\`\`\`

## Prompt per l'LLM
Nel progetto D:\\Projects\\artcraft-web l'aggiornamento upstream è fallito${engine ? ` compilando ${engine}` : ''}. Leggi AGENTS.md e questo file. I pin sono già sui nuovi tag e il sorgente upstream è in .cache/<motore>. Adatta il crate overlay in packages/<motore>/preview (mai la cache) alle nuove API upstream, senza cambiare il contratto API dei pacchetti. Verifica con \`node build.mjs ${engine ?? '<motore>'}\` e \`node test/smoke.mjs\`. Quando compila, lancia \`update-and-release.bat\` (riprende: salta i motori già compilati, poi test, versione, release). Se l'API upstream non è adattabile, usa \`update-and-release.bat --rollback\` e riferisci il motivo.
`}
## Dopo la correzione
- \`update-and-release.bat\` riprende senza ripetere i passi già completati (vedi \`--status\`).
- \`update-and-release.bat --rollback\` annulla tutto e torna all'ultimo commit.
`
  writeFileSync(handoffFile, text)
  say(`handoff for the LLM written to ${handoffFile}`)
}

function fail(reason, status = 'failed') {
  if (finished) return
  finished = true
  say(`FAILED: ${reason}`)
  if (state) { state.status = status; state.error = reason; saveState() }
  if (state?.changed?.length) writeHandoff(reason)
  writeFileSync(errorFile, `${now()}\nlog: ${logFile}\nreason: ${reason}\n${state ? `state: ${stateFile}\n` : ''}${state?.changed?.length ? `handoff: ${handoffFile}\n` : ''}\n--- last log lines ---\n${tail()}\n`)
  process.exitCode = 1
}
process.on('uncaughtException', (error) => fail(`uncaught exception: ${error?.stack ?? error}`))
process.on('unhandledRejection', (error) => fail(`unhandled rejection: ${error?.stack ?? error}`))
process.on('SIGINT', () => { fail('interrupted (Ctrl+C or window closed); rerun to resume', 'interrupted'); process.exit(130) })
process.on('SIGTERM', () => { fail('terminated; rerun to resume', 'interrupted'); process.exit(143) })
process.on('exit', (code) => { if (!finished && code !== 0) fail(`process exited with code ${code}`); write(`[${new Date().toLocaleString('it-IT')}] exit code ${process.exitCode ?? code}\n`) })

// ---- helpers ------------------------------------------------------------------------------------------------------
const run = (cmd, argv, env = {}) => new Promise((resolve) => {
  write(`$ ${cmd} ${argv.join(' ')}\n`)
  let output = ''
  const child = spawn(cmd, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { process.stdout.write(chunk); write(chunk.toString()); output += chunk; if (output.length > 4_000_000) output = output.slice(-2_000_000) })
  child.on('close', (code) => resolve({ code: code ?? 1, output }))
  child.on('error', (error) => { say(`cannot start ${cmd}: ${error}`); resolve({ code: 1, output: String(error) }) })
})
const step = async (name, title, cmd, argv, env) => {
  if (isDone(name)) { say(`skip ${title}: already done (${state.steps[name].at})`); return false }
  say(`>>> ${title}`)
  mark(name, 'running')
  const { code, output } = await run(cmd, argv, env)
  if (code !== 0) { failedBuild = { engine: undefined, output }; mark(name, 'failed', { exitCode: code }); throw new Error(`${title} failed (exit ${code})`) }
  mark(name, 'done')
  say(`<<< ${title}: ok`)
  return true
}
const git = (...argv) => new Promise((resolve) => {
  const child = spawn('git', argv, { cwd: root, stdio: 'pipe' })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  child.on('close', (code) => resolve({ code, out: out.trim() }))
  child.on('error', (error) => resolve({ code: 1, out: String(error) }))
})
const pinsNow = () => Object.fromEntries(ENGINE_NAMES.map((e) => [e, readPin(e)]))
const pinsAtHead = async () => Object.fromEntries(await Promise.all(ENGINE_NAMES.map(async (e) => [e, JSON.parse((await git('show', `HEAD:pins/${e}.json`)).out)])))
const head = async () => (await git('rev-parse', 'HEAD')).out
const bump = (version) => { const [major, minor] = version.split('.').map(Number); return `${major}.${minor + 1}.0` }
const pinChanges = (before, after) => Object.fromEntries(ENGINE_NAMES.filter((e) => before[e].tag !== after[e].tag).map((e) => [e, { from: before[e].tag, to: after[e].tag, commit: after[e].commit }]))

function newState(base, pins, versionFrom, engines) {
  return {
    schemaVersion: 1, status: 'running', startedAt: now(), updatedAt: now(), baseCommit: base,
    args, force, commit, engines, pins, changed: Object.keys(pins), rebuild: [], build: {}, steps: {},
    versionFrom, versionTo: bump(versionFrom),
  }
}

// ---- main ---------------------------------------------------------------------------------------------------------
async function main() {
  if (statusOnly) { printStatus(); finished = true; return }
  say(`start: node ${process.version}, args "${args.join(' ')}", log ${logFile}`)
  const names = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--handoff-test')
  const unknown = names.filter((name) => !ENGINES[name])
  if (unknown.length) throw new Error(`unknown engine: ${unknown.join(', ')} (valid: ${ENGINE_NAMES.join(', ')})`)
  const engines = names.length ? names : ENGINE_NAMES

  const testIndex = args.indexOf('--handoff-test')
  if (testIndex >= 0) {
    failedBuild = { engine: 'gridcraft', output: readFileSync(args[testIndex + 1], 'utf8') }
    writeHandoff('simulated build failure (--handoff-test)')
    finished = true
    return
  }

  if (rollback) {
    const headPins = await pinsAtHead()
    const moved = ENGINE_NAMES.filter((e) => readPin(e).tag !== headPins[e].tag)
    const result = await git('checkout', '--', 'pins', 'packages', 'package.json', 'package-lock.json')
    if (result.code !== 0) throw new Error(`git checkout failed: ${result.out}`)
    for (const e of moved) rmSync(join(root, '.cache', e), { recursive: true, force: true })
    for (const e of ENGINE_NAMES) rmSync(join(targetBase, e), { recursive: true, force: true })
    rmSync(handoffFile, { force: true })
    rmSync(stateFile, { force: true })
    say(`rollback done: pins, packages and version back to HEAD${moved.length ? `; removed .cache for ${moved.join(', ')}` : ''}; state and cargo targets removed. dist/ and release/ were not touched: run "npm run build" to realign dist/ with the pins`)
    finished = true
    return
  }

  // Keep the machine awake until this process exits (a sleep would stall an hours-long build).
  spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [W.P]::SetThreadExecutionState(2147483649) | Out-Null; while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep 10 }`], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()

  const base = await head()
  const saved = loadState()
  let resumed = false
  if (saved && saved.status !== 'done') {
    if (saved.baseCommit !== base) throw new Error(`HEAD moved since the update started (${saved.baseCommit?.slice(0, 8)} -> ${base.slice(0, 8)}): run --rollback, or delete logs/update-state.json to start over`)
    state = saved
    state.status = 'running'
    delete state.error
    state.force ||= force
    state.commit ||= commit
    resumed = true
    for (const [engine, info] of Object.entries(state.build)) if (info.status !== 'done') info.status = 'pending'
    for (const [name, info] of Object.entries(state.steps)) if (info.status !== 'done') delete state.steps[name]
    say(`resuming the update started ${state.startedAt}: ${Object.entries(state.pins).map(([e, p]) => `${e} ${p.from} -> ${p.to}`).join(', ') || 'no pin change (forced rebuild)'}`)
    saveState()
  } else if (resumeFlag) {
    // An interrupted run without a state file: rebuild the plan from the pins that differ from HEAD.
    const headPins = await pinsAtHead()
    const pins = pinChanges(headPins, pinsNow())
    if (!Object.keys(pins).length) throw new Error('nothing to resume: no pin differs from git HEAD and no state file exists (run without --resume)')
    const versionFrom = JSON.parse((await git('show', 'HEAD:package.json')).out).version
    state = newState(base, pins, versionFrom, engines)
    state.rebuild = state.changed.includes('wordcraft') ? ENGINE_NAMES : state.changed
    mark('updatePins', 'done', { adopted: true })
    resumed = true
    say(`adopted an interrupted update: ${Object.entries(pins).map(([e, p]) => `${e} ${p.from} -> ${p.to}`).join(', ')}`)
  } else {
    const dirty = await git('status', '--porcelain', '--', 'pins', 'packages', 'package.json', 'package-lock.json', 'build.mjs', 'scripts')
    if (dirty.out) throw new Error(`uncommitted changes in tracked project files, commit or stash first (an interrupted run without a state file: use --resume):\n${dirty.out}`)
    const before = pinsNow()
    const versionFrom = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
    state = newState(base, {}, versionFrom, engines)
    saveState()
    say('>>> upstream: update pins')
    const { code, output } = await run(process.execPath, [join(root, 'scripts/update-upstream.mjs'), ...engines])
    if (code !== 0) { await git('checkout', '--', 'pins'); failedBuild = { engine: undefined, output }; rmSync(stateFile, { force: true }); state = null; throw new Error(`upstream: update pins failed (exit ${code})`) }
    state.pins = pinChanges(before, pinsNow())
    state.changed = Object.keys(state.pins)
    say(state.changed.length ? `new upstream releases: ${Object.entries(state.pins).map(([e, p]) => `${e} ${p.from} -> ${p.to}`).join(', ')}` : 'no newer upstream release')
    if (!state.changed.length && !force) { rmSync(stateFile, { force: true }); state = null; say('nothing to do (use --force to rebuild anyway)'); finished = true; return }
    state.rebuild = state.changed.includes('wordcraft') ? ENGINE_NAMES : (state.changed.length ? state.changed : engines)
    mark('updatePins', 'done')
  }
  void resumed
  const pins = pinsNow()

  const bindgen = new Set(Object.values(pins).map((pin) => pin.wasmBindgen))
  if (bindgen.size !== 1) throw new Error(`engines disagree on wasm-bindgen (${[...bindgen].join(', ')}): align them manually`)
  const [version] = bindgen
  for (const e of ENGINE_NAMES) {
    const file = join('packages', e, 'preview', 'Cargo.toml')
    const text = readFileSync(join(root, file), 'utf8')
    const next = text.replace(/wasm-bindgen = "=[^"]+"/, `wasm-bindgen = "=${version}"`)
    if (next !== text) { writeFileSync(join(root, file), next); say(`${file}: wasm-bindgen =${version}`) }
  }

  let builtSomething = false
  for (const engine of state.rebuild) {
    const valid = existsSync(join(root, 'dist', engine)) && verifyDist(engine).length === 0
    const info = state.build[engine] ??= { status: 'pending', attempts: 0 }
    if (info.status === 'done' && valid) { say(`skip build ${engine}: done (${info.at}), dist matches ${pins[engine].tag}`); continue }
    if (valid && !state.force) { mark(`build:${engine}`, 'done', { note: 'dist already matched the pin' }); say(`skip build ${engine}: dist already matches ${pins[engine].tag}`); continue }
    let ok = false
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      say(`>>> build ${engine} (attempt ${attempt}/3, total ${info.attempts + 1})`)
      mark(`build:${engine}`, 'running', { attempts: info.attempts + 1 })
      const { code, output } = await run(process.execPath, [join(root, 'build.mjs'), engine, '--keep-target'], { CARGO_BUILD_JOBS: '1' })
      ok = code === 0
      if (ok) { mark(`build:${engine}`, 'done'); say(`<<< build ${engine}: ok`); break }
      failedBuild = { engine, output }
      mark(`build:${engine}`, 'failed', { error: extractErrors(output, 12) || output.split('\n').slice(-5).join('\n') })
      if (!MEMORY_CRASH.test(output)) { say(`build ${engine} failed with a compile or build error: no retry, the overlay probably needs adapting`); break }
      say(`build ${engine} crashed for lack of memory (0xc0000409)${attempt < 3 ? ', retrying (the compilation continues from the kept target)' : ''}`)
    }
    if (!ok) throw new Error(`build ${engine} failed${MEMORY_CRASH.test(failedBuild.output) && !extractErrors(failedBuild.output) ? ' (out of memory)' : ': see logs/llm-handoff.md'}`)
    rmSync(join(targetBase, engine), { recursive: true, force: true })
    builtSomething = true
  }
  if (builtSomething) for (const name of ['smoke', 'browser', 'release']) delete state.steps[name]

  await step('smoke', 'test: node smoke', process.execPath, [join(root, 'test/smoke.mjs')])
  await step('browser', 'test: browser', process.execPath, [join(root, 'test/browser.mjs')])

  const pkgFile = join(root, 'package.json')
  const pkgText = readFileSync(pkgFile, 'utf8')
  const current = JSON.parse(pkgText).version
  if (current !== state.versionTo) {
    writeFileSync(pkgFile, pkgText.replace(`"version": "${current}"`, `"version": "${state.versionTo}"`))
    const lockFile = join(root, 'package-lock.json')
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
    lock.version = state.versionTo
    if (lock.packages?.['']) lock.packages[''].version = state.versionTo
    writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
    say(`version ${current} -> ${state.versionTo}`)
  }
  mark('version', 'done', { version: state.versionTo })

  let releaseCurrent = false
  try { releaseCurrent = JSON.parse(readFileSync(join(root, 'release/manifest.json'), 'utf8')).version === state.versionTo } catch { /* no release yet */ }
  if (isDone('release') && releaseCurrent) say('skip release: already packed')
  else { delete state.steps.release; await step('release', 'release: pack and install check', process.execPath, [join(root, 'scripts/release.mjs'), '--skip-build']) }

  const notes = ENGINE_NAMES.map((e) => `${e} ${pins[e].tag}`).join(', ')
  if (state.commit) {
    if (isDone('commit') || (await head()) !== state.baseCommit) say('skip commit: already committed')
    else {
      await git('add', 'pins', 'packages', 'package.json', 'package-lock.json', 'build.mjs', 'scripts')
      const result = await git('commit', '-m', `release ${state.versionTo}: upstream ${notes}`)
      say(result.code === 0 ? `committed release ${state.versionTo} (no push)` : `commit failed (release files are fine): ${result.out}`)
      if (result.code === 0) mark('commit', 'done')
    }
  } else say('not committed: review "git diff" and commit, or rerun with --commit')
  rmSync(errorFile, { force: true })
  rmSync(handoffFile, { force: true })
  state.status = 'done'
  delete state.error
  saveState()
  finished = true
  say(`DONE release ${state.versionTo}: ${notes}`)
}

try {
  await main()
  finished = true
} catch (error) {
  fail(error?.message ?? String(error))
}

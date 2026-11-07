// Unattended pipeline: move pins to the latest upstream releases, rebuild, test, bump the minor version, pack the release.
// Usage: node scripts/update-and-release.mjs [engine ...] [--force] [--commit] [--resume] [--rollback]
//   --force     rebuild and re-release even when no upstream release is newer (with --resume: also rebuild engines whose dist/ is already fine)
//   --commit    commit pins, overlay changes and version on success (never pushes)
//   --resume    continue after the overlay was adapted: skips the upstream update; rebuilds the engines whose pin differs from git HEAD
//   --rollback  discard an unfinished update (git checkout of pins, packages, package.json, lock; removes the new .cache checkouts) and exit
// Every output line, error and crash goes to logs/update-<timestamp>.log; the last failure summary to logs/last-error.txt.
// A failure AFTER the pins moved is not rolled back: the new pins and the .cache checkout are what the fix needs.
// For those failures logs/llm-handoff.md holds the extracted compiler errors and a ready-made prompt for the LLM.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINE_NAMES, ENGINES, readPin, root, verifyDist } from './common.mjs'

const args = process.argv.slice(2)
const force = args.includes('--force')
const commit = args.includes('--commit')
const resume = args.includes('--resume')
const rollback = args.includes('--rollback')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const logDir = join(root, 'logs')
mkdirSync(logDir, { recursive: true })
const logFile = join(logDir, `update-${stamp}.log`)
const errorFile = join(logDir, 'last-error.txt')
const handoffFile = join(logDir, 'llm-handoff.md')

// Synchronous appends: nothing is lost if the process dies right after.
const write = (text) => { try { appendFileSync(logFile, text) } catch { /* the console still has it */ } }
const say = (text) => { const line = `[${new Date().toLocaleString('it-IT')}] ${text}`; console.log(line); write(`${line}\n`) }
const tail = (lines = 40) => { try { return readFileSync(logFile, 'utf8').split('\n').slice(-lines).join('\n') } catch { return '' } }

const MEMORY_CRASH = /0xc0000409|STATUS_STACK_BUFFER_OVERRUN|memory allocation of \d+ bytes failed/

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
let pinsMoved = false
let failedBuild = null // { engine, output } of the last failed build
let startPins = null

function writeHandoff(reason) {
  const engine = failedBuild?.engine
  const errors = failedBuild ? extractErrors(failedBuild.output) : ''
  const memory = failedBuild && MEMORY_CRASH.test(failedBuild.output) && !errors
  const pinLines = ENGINE_NAMES.map((e) => {
    const now = readPin(e)
    const was = startPins?.[e]
    return `- ${e}: ${was && was.tag !== now.tag ? `${was.tag} -> ${now.tag}` : now.tag}`
  }).join('\n')
  const text = `# Aggiornamento upstream interrotto

Data: ${new Date().toISOString()}
Motivo: ${reason}
Log completo: ${logFile}
${engine ? `Motore che ha fallito: ${engine}\n` : ''}
## Pin attuali (già spostati, non annullati)
${pinLines}

${memory
    ? `## Esito
Crash per memoria insufficiente (0xc0000409), non un errore del codice. Nessuna modifica necessaria: chiudere i programmi pesanti e rilanciare \`update-and-release.bat --resume\`.
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
Nel progetto D:\\Projects\\artcraft-web l'aggiornamento upstream è fallito${engine ? ` compilando ${engine}` : ''}. Leggi AGENTS.md e questo file. I pin sono già sui nuovi tag e il sorgente upstream è in .cache/<motore>. Adatta il crate overlay in packages/<motore>/preview (mai la cache) alle nuove API upstream, senza cambiare il contratto API dei pacchetti. Verifica con \`node build.mjs ${engine ?? '<motore>'}\` e \`node test/smoke.mjs\`. Quando compila, lancia \`update-and-release.bat --resume\` (build degli altri motori, test, release). Se l'API upstream non è adattabile, usa \`update-and-release.bat --rollback\` e riferisci il motivo.
`}
## Dopo la correzione
- \`update-and-release.bat --resume\` riprende senza ricompilare i motori già pronti.
- \`update-and-release.bat --rollback\` annulla tutto e torna all'ultimo commit.
`
  writeFileSync(handoffFile, text)
  say(`handoff for the LLM written to ${handoffFile}`)
}

function fail(reason) {
  if (finished) return
  finished = true
  say(`FAILED: ${reason}`)
  if (pinsMoved) writeHandoff(reason)
  writeFileSync(errorFile, `${new Date().toISOString()}\nlog: ${logFile}\nreason: ${reason}\n${pinsMoved ? `handoff: ${handoffFile}\n` : ''}\n--- last log lines ---\n${tail()}\n`)
  process.exitCode = 1
}
process.on('uncaughtException', (error) => fail(`uncaught exception: ${error?.stack ?? error}`))
process.on('unhandledRejection', (error) => fail(`unhandled rejection: ${error?.stack ?? error}`))
process.on('SIGINT', () => { fail('interrupted (Ctrl+C or window closed)'); process.exit(130) })
process.on('SIGTERM', () => { fail('terminated'); process.exit(143) })
process.on('exit', (code) => { if (!finished && code !== 0) fail(`process exited with code ${code}`); write(`[${new Date().toLocaleString('it-IT')}] exit code ${process.exitCode ?? code}\n`) })

const run = (cmd, argv, env = {}, capture = false) => new Promise((resolve) => {
  write(`$ ${cmd} ${argv.join(' ')}\n`)
  let output = ''
  const child = spawn(cmd, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { process.stdout.write(chunk); write(chunk.toString()); if (capture) output += chunk })
  child.on('close', (code) => resolve({ code: code ?? 1, output }))
  child.on('error', (error) => { say(`cannot start ${cmd}: ${error}`); resolve({ code: 1, output: String(error) }) })
})
const step = async (title, cmd, argv, env) => {
  say(`>>> ${title}`)
  const { code, output } = await run(cmd, argv, env, true)
  if (code !== 0) { failedBuild = { engine: undefined, output }; throw new Error(`${title} failed (exit ${code})`) }
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
const pinsNow = () => Object.fromEntries(ENGINE_NAMES.map((e) => [e, readPin(e)]))
const pinsAtHead = async () => Object.fromEntries(await Promise.all(ENGINE_NAMES.map(async (e) => [e, JSON.parse((await git('show', `HEAD:pins/${e}.json`)).out)])))

async function main() {
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
    const head = await pinsAtHead()
    const moved = ENGINE_NAMES.filter((e) => readPin(e).tag !== head[e].tag)
    const result = await git('checkout', '--', 'pins', 'packages', 'package.json', 'package-lock.json')
    if (result.code !== 0) throw new Error(`git checkout failed: ${result.out}`)
    for (const e of moved) rmSync(join(root, '.cache', e), { recursive: true, force: true })
    rmSync(handoffFile, { force: true })
    say(`rollback done: pins, packages and version back to HEAD${moved.length ? `; removed .cache for ${moved.join(', ')}` : ''}. dist/ and release/ were not touched: run "npm run build" to realign dist/ with the pins`)
    finished = true
    return
  }

  // Keep the machine awake until this process exits (a sleep would stall an hours-long build).
  spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [W.P]::SetThreadExecutionState(2147483649) | Out-Null; while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep 10 }`], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()

  let changed
  let before
  if (resume) {
    before = await pinsAtHead()
    startPins = before
    changed = ENGINE_NAMES.filter((e) => readPin(e).tag !== before[e].tag)
    if (!changed.length) throw new Error('nothing to resume: no pin differs from git HEAD (run without --resume)')
    pinsMoved = true
    say(`resuming: ${changed.map((e) => `${e} ${before[e].tag} -> ${readPin(e).tag}`).join(', ')}`)
  } else {
    const dirty = await git('status', '--porcelain', '--', 'pins', 'packages', 'package.json', 'package-lock.json', 'build.mjs', 'scripts')
    if (dirty.out) throw new Error(`uncommitted changes in tracked project files, commit or stash first (or use --resume / --rollback after a failed update):\n${dirty.out}`)
    before = pinsNow()
    startPins = before
    try {
      await step('upstream: update pins', process.execPath, [join(root, 'scripts/update-upstream.mjs'), ...engines])
    } catch (error) {
      await git('checkout', '--', 'pins')
      throw error
    }
    pinsMoved = true
    const after = pinsNow()
    changed = ENGINE_NAMES.filter((e) => before[e].tag !== after[e].tag)
    say(changed.length ? `new upstream releases: ${changed.map((e) => `${e} ${before[e].tag} -> ${after[e].tag}`).join(', ')}` : 'no newer upstream release')
    if (!changed.length && !force) { pinsMoved = false; say('nothing to do (use --force to rebuild anyway)'); return }
  }
  const after = pinsNow()

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
    if (resume && !force && existsSync(join(root, 'dist', engine)) && verifyDist(engine).length === 0) { say(`dist/${engine} already matches pin ${after[engine].tag}: skipped`); continue }
    let ok = false
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      say(`>>> build ${engine} (attempt ${attempt}/3)`)
      const { code, output } = await run(process.execPath, [join(root, 'build.mjs'), engine], { CARGO_BUILD_JOBS: '1' }, true)
      ok = code === 0
      if (ok) { say(`<<< build ${engine}: ok`); break }
      failedBuild = { engine, output }
      if (!MEMORY_CRASH.test(output)) { say(`build ${engine} failed with a compile or build error: no retry, the overlay probably needs adapting`); break }
      say(`build ${engine} crashed for lack of memory (0xc0000409)${attempt < 3 ? ', retrying' : ''}`)
    }
    if (!ok) throw new Error(`build ${engine} failed${MEMORY_CRASH.test(failedBuild.output) && !extractErrors(failedBuild.output) ? ' (out of memory)' : ': see logs/llm-handoff.md'}`)
  }

  await step('test: node smoke', process.execPath, [join(root, 'test/smoke.mjs')])
  await step('test: browser', process.execPath, [join(root, 'test/browser.mjs')])

  const pkgText = readFileSync(join(root, 'package.json'), 'utf8')
  const pkg = JSON.parse(pkgText)
  const [major, minor] = pkg.version.split('.').map(Number)
  const next = `${major}.${minor + 1}.0`
  writeFileSync(join(root, 'package.json'), pkgText.replace(`"version": "${pkg.version}"`, `"version": "${next}"`))
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  lock.version = next
  if (lock.packages?.['']) lock.packages[''].version = next
  writeFileSync(join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
  say(`version ${pkg.version} -> ${next}`)

  await step('release: pack and install check', process.execPath, [join(root, 'scripts/release.mjs'), '--skip-build'])

  const notes = ENGINE_NAMES.map((e) => `${e} ${after[e].tag}`).join(', ')
  if (commit) {
    await git('add', 'pins', 'packages', 'package.json', 'package-lock.json', 'build.mjs', 'scripts')
    const result = await git('commit', '-m', `release ${next}: upstream ${notes}`)
    say(result.code === 0 ? `committed release ${next} (no push)` : `commit failed (release files are fine): ${result.out}`)
  } else say('not committed: review "git diff" and commit, or rerun with --commit')
  rmSync(errorFile, { force: true })
  rmSync(handoffFile, { force: true })
  finished = true
  say(`DONE release ${next}: ${notes}`)
}

try {
  await main()
  finished = true
} catch (error) {
  fail(error?.message ?? String(error))
}

// The release system's last step: tags the release and publishes it on GitHub (acaprino/artcraft-web).
//   1. release/ must hold the packages of package.json's version (npm run release, or update-and-release --commit);
//   2. the tag v<version> is created, annotated, on HEAD (the release commit) unless it already exists;
//   3. the branch and the tag are pushed;
//   4. the GitHub release v<version> is created on that tag with one .tgz per engine, manifest.json and SHA256SUMS.
// Qemille and Ethel always download the latest GitHub release. A published version is never replaced: a new
// release needs a new version.
// Usage: npm run publish:github   (gh signed in)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { root } from './common.mjs'

const REPO = 'acaprino/artcraft-web'
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const succeeds = (cmd, args) => { try { run(cmd, args); return true } catch { return false } }
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const fail = (message) => { console.error(`publish: ${message}`); process.exit(1) }

const release = join(root, 'release')
const manifestFile = join(release, 'manifest.json')
const sums = join(release, 'SHA256SUMS')
if (!existsSync(manifestFile) || !existsSync(sums)) fail('release/manifest.json or release/SHA256SUMS missing: run npm run release first.')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (manifest.version !== version) fail(`release/ is ${manifest.version} but package.json is ${version}: run npm run release again.`)

const files = [manifestFile, sums]
for (const pkg of manifest.packages) {
  const file = join(release, pkg.file)
  if (!existsSync(file)) fail(`${pkg.file} missing.`)
  if (sha256(file) !== pkg.sha256) fail(`${pkg.file}: SHA-256 differs from manifest.json.`)
  files.push(file)
}

const tag = `v${version}`
if (succeeds('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'tagName'])) fail(`${tag} is already published: a new release needs a new version.`)

const branch = run('git', ['branch', '--show-current'])
if (!succeeds('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])) {
  if (run('git', ['status', '--porcelain', '--', 'package.json', 'pins', 'packages'])) fail('package.json, pins/ or packages/ have uncommitted changes: commit the release first.')
  run('git', ['tag', '-a', tag, '-m', `artcraft-web ${version}`])
  console.log(`publish: tag ${tag} created on ${run('git', ['rev-parse', '--short', 'HEAD'])}`)
}
run('git', ['push', 'origin', branch, tag])

const notes = manifest.packages.map((p) => `- ${p.engine} ${p.tag} (${p.commit.slice(0, 7)}), ${(p.bytes / 1e6).toFixed(1)} MB`).join('\n')
run('gh', ['release', 'create', tag, '--repo', REPO, '--verify-tag', '--latest', '--title', `artcraft-web ${version}`, '--notes', `Upstream engines:\n${notes}`, ...files])
console.log(`publish: ${tag} published on ${REPO} with ${files.length} files.`)

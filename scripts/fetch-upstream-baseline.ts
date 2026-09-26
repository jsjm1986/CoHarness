/** Prepare the pinned public tag and comparison commits without replacing tags or fetching full history. */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const upstream = 'https://github.com/deepseek-ai/deepseek-harness.git'
const commitId = /^[a-f0-9]{40,64}$/
const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/upstream-sync.json'), 'utf8')) as { syncedTag?: unknown; syncedCommit?: unknown }
if (typeof manifest.syncedTag !== 'string' || !/^dsh-v[\w.+-]+$/.test(manifest.syncedTag)
  || typeof manifest.syncedCommit !== 'string' || !commitId.test(manifest.syncedCommit)) {
  throw new Error('upstream baseline: invalid pinned tag or commit')
}

function comparisonCommit(value: unknown, label: string): string {
  if (value === null || typeof value !== 'object' || !('commit' in value)
    || typeof value.commit !== 'string' || !commitId.test(value.commit)) {
    throw new Error(`upstream baseline: invalid ${label} commit`)
  }
  return value.commit
}

const matrix = JSON.parse(readFileSync(resolve(root, `upgrades/alignment/UPSTREAM-ALIGNMENT-MATRIX-${manifest.syncedTag}.json`), 'utf8')) as {
  baseline?: unknown
  incrementBaseline?: unknown
  target?: { tag?: unknown; commit?: unknown }
}
if (matrix.target?.tag !== manifest.syncedTag || comparisonCommit(matrix.target, 'target') !== manifest.syncedCommit) {
  throw new Error('upstream baseline: matrix target differs from the pinned tag and commit')
}
const commits = new Set([
  manifest.syncedCommit,
  comparisonCommit(matrix.baseline, 'cumulative baseline'),
  ...matrix.incrementBaseline === undefined ? [] : [comparisonCommit(matrix.incrementBaseline, 'incremental baseline')],
])

const ref = `refs/tags/${manifest.syncedTag}`
const existing = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' })
if (existing.status !== 0) {
  execFileSync('git', ['fetch', '--depth=1', '--no-tags', upstream, `${ref}:${ref}`],
    { cwd: root, stdio: 'inherit', timeout: 120_000 })
}
const commit = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
if (commit !== manifest.syncedCommit) throw new Error('upstream baseline: fetched tag differs from the pinned commit')

for (const pinned of commits) {
  const available = spawnSync('git', ['cat-file', '-e', `${pinned}^{tree}`], { cwd: root, stdio: 'ignore' })
  if (available.status !== 0) {
    execFileSync('git', ['fetch', '--depth=1', '--no-tags', upstream, pinned],
      { cwd: root, stdio: 'inherit', timeout: 120_000 })
  }
  const actual = execFileSync('git', ['rev-parse', '--verify', `${pinned}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
  if (actual !== pinned) throw new Error(`upstream baseline: comparison input ${pinned} is not the declared commit`)
  execFileSync('git', ['cat-file', '-e', `${pinned}^{tree}`], { cwd: root, stdio: 'ignore' })
}
console.log(`upstream baseline: ${manifest.syncedTag} at ${commit}; ${String(commits.size)} pinned comparison trees available`)

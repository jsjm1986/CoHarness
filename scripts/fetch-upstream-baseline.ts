/** Fetch only the declared public upstream tag, without replacing an existing local tag. */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/upstream-sync.json'), 'utf8')) as { syncedTag?: unknown; syncedCommit?: unknown }
if (typeof manifest.syncedTag !== 'string' || !/^dsh-v[\w.+-]+$/.test(manifest.syncedTag)
  || typeof manifest.syncedCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(manifest.syncedCommit)) {
  throw new Error('upstream baseline: invalid pinned tag or commit')
}
const ref = `refs/tags/${manifest.syncedTag}`
const existing = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' })
if (existing.status !== 0) {
  execFileSync('git', ['fetch', '--depth=1', '--no-tags', 'https://github.com/deepseek-ai/deepseek-harness.git', `${ref}:${ref}`],
    { cwd: root, stdio: 'inherit', timeout: 120_000 })
}
const commit = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
if (commit !== manifest.syncedCommit) throw new Error('upstream baseline: fetched tag differs from the pinned commit')
console.log(`upstream baseline: ${manifest.syncedTag} at ${commit}`)

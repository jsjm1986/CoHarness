/**
 * Generate `upgrades/alignment/UPSTREAM-COMMIT-INVENTORY-<tag>.json`: every
 * non-merge upstream commit between the synced baseline and a newer tag,
 * bucketed by the sovereignty manifest so `verify-upgrade-records` can prove
 * each commit that touches a carried package is claimed by some matrix row.
 *
 * Usage: `pnpm run gen-upstream-commit-inventory -- --tag dsh-v0.1.5-rc.2`
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadUpstreamSyncManifest, resolveTagCommit } from './verify-upstream-sovereignty.ts'
import { readUpstreamCommitInventory } from './upstream-commit-inventory.ts'

const root = resolve(import.meta.dirname, '..')

function fail(message: string): never {
  throw new Error(`gen-upstream-commit-inventory: ${message}`)
}

function git(args: string[]): string {
  const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 27 })
  if (run.error !== undefined) fail(`git ${args.join(' ')} failed to spawn: ${run.error.message}`)
  if (run.status !== 0) fail(`git ${args.join(' ')} failed: ${run.stderr.trim()}`)
  return run.stdout
}

function main(args: string[]): number {
  const tagIndex = args.indexOf('--tag')
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined
  if (tag === undefined || tag.startsWith('--')) fail('usage: gen-upstream-commit-inventory --tag <newTag> [--from <baselineCommit>]')
  const manifest = loadUpstreamSyncManifest(root)
  const toCommit = resolveTagCommit(root, tag)
  if (toCommit === null) fail(`tag "${tag}" is not fetched locally`)
  const fromIndex = args.indexOf('--from')
  const fromArg = fromIndex >= 0 ? args[fromIndex + 1] : undefined
  const baselineCommit = git(['rev-parse', '--verify', '--end-of-options', `${fromArg ?? manifest.syncedCommit}^{commit}`]).trim()
  const baselineTag = fromArg === undefined ? manifest.syncedTag : fromArg

  const commits = readUpstreamCommitInventory(root, baselineCommit, toCommit, manifest)

  const out = {
    schemaVersion: 1,
    generatedFrom: { baseline: baselineTag, baselineCommit, target: tag, targetCommit: toCommit },
    commitCount: commits.length,
    commits,
  }
  const file = resolve(root, 'upgrades/alignment', `UPSTREAM-COMMIT-INVENTORY-${tag}.json`)
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
  const carried = commits.filter(c => c.bucket === 'carried').length
  console.log(`gen-upstream-commit-inventory: wrote ${file} — ${String(commits.length)} commits, ${String(carried)} touch carried packages.`)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message.startsWith('gen-upstream-commit-inventory:') ? message : `gen-upstream-commit-inventory: ${message}`)
    process.exitCode = 1
  }
}

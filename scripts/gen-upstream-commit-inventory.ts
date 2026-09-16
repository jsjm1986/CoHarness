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

const PACKAGE_DIR = /^packages\/([0-9A-Za-z._-]+\/[0-9A-Za-z._-]+)\//

/** One upstream commit and the manifest bucket its touched packages fall in. */
interface InventoryCommit {
  sha: string
  subject: string
  /** `<group>/<pkg>` keys the commit touches; empty when none. */
  packages: string[]
  /**
   * `carried` when any touched package is tracked/adapted/replaced on disk,
   * `newUpstream` when some touched package is absent from the manifest
   * entirely (added upstream after the synced tag), `upstreamOnly` when all
   * touched packages are registered not-carried, `owned` when all touched
   * packages are owned, `none` when the commit touches no package.
   */
  bucket: 'carried' | 'newUpstream' | 'upstreamOnly' | 'owned' | 'none'
}

function main(args: string[]): number {
  const tagIndex = args.indexOf('--tag')
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined
  if (tag === undefined || tag.startsWith('--')) fail('usage: gen-upstream-commit-inventory --tag <newTag>')
  const manifest = loadUpstreamSyncManifest(root)
  const toCommit = resolveTagCommit(root, tag)
  if (toCommit === null) fail(`tag "${tag}" is not fetched locally`)

  const upstreamOnly = new Set(manifest.upstreamOnly.map(item => item.package))
  const log = git(['log', '--no-merges', '--format=%H%x00%s%x00', `${manifest.syncedCommit}..${toCommit}`])
  const commits: InventoryCommit[] = []
  for (const record of log.split('\0\n')) {
    const line = record.replace(/\0$/, '')
    if (line.trim() === '') continue
    const [sha, subject] = line.split('\0')
    if (sha === undefined) continue
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean)
    const keys = [...new Set(files.map(f => PACKAGE_DIR.exec(f)?.[1]).filter((k): k is string => k !== undefined))].sort()
    const sovereignties = keys.map(k => manifest.packages[k]?.sovereignty)
    const bucket: InventoryCommit['bucket'] = keys.length === 0
      ? 'none'
      : sovereignties.some(s => s === 'tracked' || s === 'adapted' || s === 'replaced')
        ? 'carried'
        : keys.some(k => manifest.packages[k] === undefined && !upstreamOnly.has(k))
          ? 'newUpstream'
          : keys.every(k => upstreamOnly.has(k))
            ? 'upstreamOnly'
            : 'owned'
    commits.push({ sha, subject: subject ?? '', packages: keys, bucket })
  }

  const out = {
    schemaVersion: 1,
    generatedFrom: { baseline: manifest.syncedTag, baselineCommit: manifest.syncedCommit, target: tag, targetCommit: toCommit },
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

/**
 * Print a Markdown increment report for moving the synced upstream baseline to a
 * newer release tag.
 *
 * `git diff --name-status <baseline> <tag> -- packages/` is bucketed by the
 * sovereignty manifest in `scripts/upstream-sync.json`: `tracked` packages are
 * conflicts that must be reconciled file by file, `adapted` packages need a
 * judgment call per delta, `replaced` packages own their contract and absorb
 * upstream by behavior port, `owned` packages can ignore upstream motion.
 * Directories added or removed upstream and all non-`packages/` changes are
 * summarized so no upstream movement falls out of the report. Read-only.
 *
 * `--residue <olderTag>` additionally lists two below-baseline populations
 * under `adapted`/`replaced` packages: `stale` files still identical to
 * `<olderTag>` even though upstream changed them before the synced commit,
 * and `unadopted` files upstream added in that window that the fork never
 * carried — the mechanical detector a sovereignty class alone cannot show.
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  loadUpstreamSyncManifest,
  packageKeysAtCommit,
  resolveTagCommit,
  type Sovereignty,
  type UpstreamSyncManifest,
} from './verify-upstream-sovereignty.ts'

const root = resolve(import.meta.dirname, '..')

/** Parsed `--tag`/`--from`/`--residue` CLI arguments. */
export interface ReportArgs {
  /** Required newer upstream tag to report toward. */
  tag: string
  /** Optional baseline tag overriding the manifest's `syncedTag`. */
  from: string | undefined
  /** Optional older tag whose unchanged files flag below-baseline residue. */
  residue: string | undefined
}

function fail(message: string): never {
  throw new Error(`sync-upstream-report: ${message}`)
}

/**
 * Parse the report CLI arguments.
 * @param args - process arguments after the script name.
 * @returns the resolved tag and optional baseline override.
 */
export function parseReportArgs(args: string[]): ReportArgs {
  let tag: string | undefined
  let from: string | undefined
  let residue: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') continue // `pnpm run <script> -- args` forwards the separator
    if (arg === '--tag' || arg === '--from' || arg === '--residue') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) fail(`${arg} requires a tag value`)
      if (arg === '--tag') tag = value
      else if (arg === '--from') from = value
      else residue = value
      i += 1
      continue
    }
    fail(`unknown argument ${JSON.stringify(arg)}; usage: upstream-sync:report --tag <newTag> [--from <baselineTag>] [--residue <olderTag>]`)
  }
  if (tag === undefined) fail('missing required --tag <newTag>')
  return { tag, from, residue }
}

/** One `git diff --name-status` record; `oldPath` is set for renames/copies. */
export interface NameStatusEntry {
  status: string
  path: string
  oldPath?: string
}

/**
 * Parse `git diff --name-status` output into records.
 * @param output - raw name-status text, tab-separated fields per line.
 * @returns one entry per changed path; rename/copy entries carry `oldPath`.
 */
export function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const fields = line.split('\t')
    const status = fields[0]?.[0] ?? ''
    if ((status === 'R' || status === 'C') && fields.length >= 3) {
      entries.push({ status, oldPath: fields[1] ?? '', path: fields[2] ?? '' })
    } else {
      entries.push({ status, path: fields[1] ?? '' })
    }
  }
  return entries
}

/** A name-status record attributed to its `<group>/<pkg>` package key. */
export interface PackageChange extends NameStatusEntry {
  key: string
}

/** Sovereignty buckets plus the two non-manifest populations a diff can hit. */
export type ChangeBucket = Sovereignty | 'upstreamOnly' | 'unmanifested'

/** One file still carrying pre-baseline content under an adapted/replaced package. */
export interface ResidueEntry {
  key: string
  path: string
}

/** The two below-baseline populations `findBelowBaselineResidue` separates. */
export interface ResidueReport {
  /** Present at the residue tag and on HEAD, changed upstream since. */
  stale: ResidueEntry[]
  /** Added upstream after the residue tag, never carried locally. */
  unadopted: ResidueEntry[]
}

/**
 * Bucket `packages/` name-status entries by manifest sovereignty.
 * @param entries - parsed name-status records (any path scope).
 * @param manifest - the sovereignty manifest.
 * @returns entries under `packages/<group>/<pkg>/`, keyed per bucket; other
 * paths are ignored here and summarized by `topLevelChangeCounts`.
 */
export function bucketPackageChanges(
  entries: readonly NameStatusEntry[],
  manifest: UpstreamSyncManifest,
): Record<ChangeBucket, PackageChange[]> {
  const buckets: Record<ChangeBucket, PackageChange[]> = {
    tracked: [], adapted: [], owned: [], replaced: [], upstreamOnly: [], unmanifested: [],
  }
  const upstreamOnly = new Set(manifest.upstreamOnly.map(item => item.package))
  for (const entry of entries) {
    if (!entry.path.startsWith('packages/')) continue
    const match = /^packages\/([0-9A-Za-z._-]+\/[0-9A-Za-z._-]+)\//.exec(entry.path)
    const key = match?.[1] ?? entry.path
    const sovereignty = match === null ? undefined : manifest.packages[key]?.sovereignty
    const bucket: ChangeBucket = sovereignty ?? (upstreamOnly.has(key) ? 'upstreamOnly' : 'unmanifested')
    buckets[bucket].push({ ...entry, key })
  }
  return buckets
}

/**
 * List files under `adapted`/`replaced` packages whose HEAD content is still
 * identical to `residueCommit` even though upstream changed them before the
 * synced commit — the residue the sovereignty class alone cannot show.
 * @param repoRoot - repository root the git invocations run in.
 * @param manifest - the sovereignty manifest.
 * @param residueCommit - older upstream commit to compare file contents against.
 * @returns residue entries sorted by package key then path.
 */
export function findBelowBaselineResidue(
  repoRoot: string,
  manifest: UpstreamSyncManifest,
  residueCommit: string,
): ResidueReport {
  const byPath = (a: ResidueEntry, b: ResidueEntry): number =>
    a.key === b.key ? a.path.localeCompare(b.path) : a.key.localeCompare(b.key)
  const stale: ResidueEntry[] = []
  const unadopted: ResidueEntry[] = []
  const candidates = Object.entries(manifest.packages)
    .filter(([, entry]) => entry.sovereignty === 'adapted' || entry.sovereignty === 'replaced')
    .map(([key]) => key)
  for (const key of candidates) {
    const changed = git(repoRoot, [
      'diff', '--name-only', '-z', residueCommit, manifest.syncedCommit, '--', `packages/${key}/src`,
    ])
    for (const path of changed.split('\0')) {
      if (path === '') continue
      const atResidue = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${residueCommit}:${path}`], { encoding: 'utf8' })
      if (atResidue.status !== 0) {
        const onDisk = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `HEAD:${path}`], { encoding: 'utf8' })
        if (onDisk.status !== 0) unadopted.push({ key, path })
        continue
      }
      const sameAsResidue = spawnSync('git', ['-C', repoRoot, 'diff', '--quiet', residueCommit, 'HEAD', '--', path], { encoding: 'utf8' })
      if (sameAsResidue.status === 0) stale.push({ key, path })
    }
  }
  return { stale: stale.sort(byPath), unadopted: unadopted.sort(byPath) }
}

/**
 * Count changed files per top-level path outside `packages/`.
 * @param entries - parsed name-status records.
 * @returns top-level segment → changed-file count, sorted by segment.
 */
export function topLevelChangeCounts(entries: readonly NameStatusEntry[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.path.startsWith('packages/')) continue
    const top = entry.path.split('/')[0] ?? entry.path
    counts.set(top, (counts.get(top) ?? 0) + 1)
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
}

function git(repoRoot: string, args: string[]): string {
  // quotepath=false keeps non-ASCII paths unquoted so buckets see real names.
  const run = spawnSync('git', ['-C', repoRoot, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (run.error !== undefined) fail(`git ${args.join(' ')} failed to spawn: ${run.error.message}`)
  if (run.status !== 0) fail(`git ${args.join(' ')} failed: ${run.stderr.trim()}`)
  return run.stdout
}

function requireTag(repoRoot: string, tag: string): string {
  const commit = resolveTagCommit(repoRoot, tag)
  if (commit === null) {
    fail(`tag "${tag}" is not fetched locally; fetch it with \`git fetch --tags origin\` or \`git fetch upstream --tags\` and re-run`)
  }
  return commit
}

function statusSummary(entries: readonly NameStatusEntry[]): string {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1)
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([s, n]) => `${s}:${String(n)}`).join(' ')
}

function renderBucket(heading: string, entries: readonly PackageChange[]): string[] {
  const lines = [`## ${heading}`, '']
  if (entries.length === 0) {
    lines.push('_No upstream changes._', '')
    return lines
  }
  const byKey = new Map<string, PackageChange[]>()
  for (const entry of entries) byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry])
  for (const [key, list] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- \`${key}\` — ${String(list.length)} file(s) (${statusSummary(list)})`)
  }
  lines.push('')
  return lines
}

/** CLI entry: resolve the refs, diff them, and print the Markdown report. */
function main(args: string[]): number {
  const { tag, from, residue } = parseReportArgs(args)
  const manifest = loadUpstreamSyncManifest(root)
  const toCommit = requireTag(root, tag)
  const fromLabel = from ?? manifest.syncedTag
  const fromCommit = from === undefined ? manifest.syncedCommit : requireTag(root, from)

  const entries = parseNameStatus(git(root, ['diff', '--name-status', fromCommit, toCommit]))
  const buckets = bucketPackageChanges(entries, manifest)
  const fromKeys = packageKeysAtCommit(root, fromCommit)
  const toKeys = packageKeysAtCommit(root, toCommit)
  const newUpstream = [...toKeys].filter(key => !fromKeys.has(key)).sort()
  const removedUpstream = [...fromKeys].filter(key => !toKeys.has(key)).sort()

  const out: string[] = [
    `# Upstream sync report: ${fromLabel} → ${tag}`,
    '',
    `Baseline \`${fromCommit}\` → \`${toCommit}\`; buckets per \`scripts/upstream-sync.json\`.`,
    '',
    ...renderBucket('tracked (conflicts — must reconcile)', buckets.tracked),
    ...renderBucket('adapted', buckets.adapted),
    ...renderBucket('replaced (owned contract — absorb by behavior port)', buckets.replaced),
    ...renderBucket('owned (ignore upstream)', buckets.owned),
    ...renderBucket('upstream-only (not carried locally)', buckets.upstreamOnly),
  ]
  if (residue !== undefined) {
    const residueCommit = requireTag(root, residue)
    const report = findBelowBaselineResidue(root, manifest, residueCommit)
    out.push(`## below-baseline residue vs ${residue}`, '')
    const render = (heading: string, entries2: readonly ResidueEntry[]): void => {
      out.push(`### ${heading}`, '')
      if (entries2.length === 0) out.push('_None._', '')
      const byKey = new Map<string, ResidueEntry[]>()
      for (const entry of entries2) byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry])
      for (const [key, list] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
        out.push(`- \`${key}\` — ${String(list.length)} file(s)`)
        for (const entry of list) out.push(`  - \`${entry.path}\``)
      }
      out.push('')
    }
    render('stale (held at the residue-tag content)', report.stale)
    render('unadopted (added upstream, never carried)', report.unadopted)
  }
  // Unmanifested entries under a directory upstream added after the baseline
  // are that new package's churn; anything else is a stray packages/ path.
  const newUpstreamSet = new Set(newUpstream)
  const stray = buckets.unmanifested.filter(entry => !newUpstreamSet.has(entry.key))
  const newChurn = new Map<string, PackageChange[]>()
  for (const entry of buckets.unmanifested) {
    if (newUpstreamSet.has(entry.key)) newChurn.set(entry.key, [...(newChurn.get(entry.key) ?? []), entry])
  }
  if (stray.length > 0) {
    out.push('## unmanifested packages/ paths', '')
    for (const entry of stray) out.push(`- \`${entry.path}\` (${entry.status})`)
    out.push('')
  }
  out.push('## new upstream packages', '')
  const fresh = newUpstream.filter(key => manifest.packages[key]?.sovereignty !== 'owned')
  const collisions = newUpstream.filter(key => manifest.packages[key]?.sovereignty === 'owned')
  if (fresh.length === 0 && collisions.length === 0) out.push('_None._', '')
  for (const key of fresh) {
    const churn = newChurn.get(key)
    out.push(`- \`${key}\`${churn === undefined ? '' : ` — ${String(churn.length)} file(s) (${statusSummary(churn)})`}`)
  }
  for (const key of collisions) out.push(`- \`${key}\` — collides with a locally owned package; adoption needs a name decision`)
  out.push('', '## removed upstream packages', '')
  if (removedUpstream.length === 0) out.push('_None._', '')
  for (const key of removedUpstream) out.push(`- \`${key}\``)
  out.push('', '## other upstream changes (non-packages/)', '')
  const others = topLevelChangeCounts(entries)
  if (others.length === 0) out.push('_None._', '')
  for (const [top, count] of others) out.push(`- \`${top}\` — ${String(count)} file(s)`)
  console.log(out.join('\n'))
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message.startsWith('sync-upstream-report:') ? message : `sync-upstream-report: ${message}`)
    process.exitCode = 1
  }
}

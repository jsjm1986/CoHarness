/** Read upstream commit membership and package ownership from complete Git ancestry. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** One non-merge commit and the current manifest classification of its changed packages. */
export interface InventoryCommit {
  sha: string
  subject: string
  packages: string[]
  bucket: 'carried' | 'newUpstream' | 'upstreamOnly' | 'owned' | 'none'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read the commits reachable from the target but absent from the baseline's ancestry.
 * Shallow cutoffs reachable from either endpoint invalidate this comparison;
 * unrelated shallow refs in the same object database do not.
 * @param repoRoot - Git checkout containing both recorded endpoints.
 * @param baselineCommit - full commit id excluded from the interval, along with its ancestors.
 * @param targetCommit - full commit id whose non-merge ancestors are inventoried.
 * @param manifest - parsed sovereignty manifest supplying packages and upstreamOnly.
 * @returns commits in Git log order, with sorted package keys and current ownership buckets.
 */
export function readUpstreamCommitInventory(
  repoRoot: string,
  baselineCommit: string,
  targetCommit: string,
  manifest: unknown,
): InventoryCommit[] {
  function fail(message: string): never { throw new Error(`upstream commit inventory: ${message}`) }
  if (![baselineCommit, targetCommit].every(value => /^[0-9a-f]{40,64}$/.test(value))) {
    fail('baseline and target must be full commit ids')
  }
  if (!isRecord(manifest) || !isRecord(manifest.packages) || !Array.isArray(manifest.upstreamOnly)) {
    fail('requires packages and upstreamOnly from the sovereignty manifest')
  }
  const sovereignties = new Map<string, string>()
  for (const [key, entry] of Object.entries(manifest.packages)) {
    if (!isRecord(entry) || typeof entry.sovereignty !== 'string' || !['tracked', 'adapted', 'replaced', 'owned'].includes(entry.sovereignty)) {
      fail(`invalid sovereignty for ${key}`)
    }
    sovereignties.set(key, entry.sovereignty)
  }
  const upstreamOnly = new Set<string>()
  for (const entry of manifest.upstreamOnly as unknown[]) {
    if (!isRecord(entry) || typeof entry.package !== 'string' || entry.package === '') {
      fail('invalid upstreamOnly package')
    }
    upstreamOnly.add(entry.package)
  }
  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const shallowPath = resolve(repoRoot, git(['rev-parse', '--git-path', 'shallow']).trim())
  if (existsSync(shallowPath)) {
    const ancestors = new Set(git(['rev-list', baselineCommit, targetCommit]).trim().split('\n'))
    const cutoffs = readFileSync(shallowPath, 'utf8').trim().split('\n').filter(sha => ancestors.has(sha))
    if (cutoffs.length > 0) {
      fail(`shallow ancestry at ${cutoffs.slice(0, 5).join(', ')}; fetch complete history for both endpoints before generating or verifying the inventory`)
    }
  }
  const log = git(['log', '--no-merges', '--format=%H%x00%s%x00', `${baselineCommit}..${targetCommit}`])
  const commits: InventoryCommit[] = []
  for (const record of log.split('\0\n')) {
    const line = record.replace(/\0$/, '')
    if (line === '') continue
    const [sha, subject] = line.split('\0')
    if (sha === undefined || subject === undefined) fail('invalid Git log record')
    const files = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-z', '-r', sha]).split('\0')
    const packages = [...new Set(files.map(path => /^packages\/([0-9A-Za-z._-]+\/[0-9A-Za-z._-]+)\//.exec(path)?.[1])
      .filter((key): key is string => key !== undefined))].sort()
    const bucket: InventoryCommit['bucket'] = packages.length === 0
      ? 'none'
      : packages.some(key => ['tracked', 'adapted', 'replaced'].includes(sovereignties.get(key) ?? ''))
        ? 'carried'
        : packages.some(key => !sovereignties.has(key) && !upstreamOnly.has(key))
          ? 'newUpstream'
          : packages.every(key => upstreamOnly.has(key))
            ? 'upstreamOnly'
            : 'owned'
    commits.push({ sha, subject, packages, bucket })
  }
  return commits
}
